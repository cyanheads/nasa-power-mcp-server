/** @fileoverview Bounded explicit-token analytical workspace. @module services/canvas/canvas-service */
import { randomUUID } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  DataCanvas,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { POWER_LIMITS, type ServerConfig } from '@/config/server-config.js';
import { type ObservationRow, powerError } from '../power/index.js';
import { canvasError, safeCanvasError } from './errors.js';
import { formatFaithfully } from './format.js';
import {
  type ComparisonDataset,
  type PresentableDataset,
  type PresentedDataset,
  type Provenance,
  ProvenanceSchema,
  QueryResultSchema,
  type ScientificColumn,
} from './types.js';

type SummaryTable = {
  key: 'buckets' | 'locations';
  table: string;
  rows: Record<string, string | number | boolean | null | undefined>[];
  columns: ScientificColumn[];
};

type TableRecord = {
  bytes: number;
  columns: ScientificColumn[];
  provenance: Provenance;
  cleanup: boolean;
};
type CanvasRecord = {
  id: string;
  tenant: string;
  ctx: Context;
  created: number;
  busy: boolean;
  pending: boolean;
  tables: Map<string, TableRecord>;
};
type Producer = {
  tenant: string;
  bytes: number;
  controller: AbortController;
  settled: Promise<void>;
};
/** Service dependencies; native lifecycle settings are supplied to the framework at startup. */
export type CanvasServiceOptions = {
  canvas?: DataCanvas;
  storage: StorageService;
  now?: () => number;
  config: ServerConfig;
  reconciliationMs?: number;
};

/** Explicit token access, atomic admission, and native-lifecycle reconciliation. */
export class CanvasService {
  private readonly canvas: DataCanvas | undefined;
  private readonly storage: StorageService;
  private readonly now: () => number;
  private readonly config: ServerConfig;
  private readonly records = new Map<string, CanvasRecord>();
  private readonly producers = new Set<Producer>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly shutdownController = new AbortController();
  private queryCount = 0;
  private stopped = false;
  private reconciliation: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(options: CanvasServiceOptions) {
    this.canvas = options.canvas;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.config = options.config;
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {
        /* Individual records retain reservations and log failures. */
      });
    }, options.reconciliationMs ?? 30_000);
    this.timer.unref();
  }

  /** Availability is a configuration fact; native initialization can still fail. */
  get enabled(): boolean {
    return this.canvas !== undefined;
  }
  /** Producer admission includes cache-hit copies and spans fetch through presentation. */
  async withProducer<T>(
    kind: 'single' | 'comparison',
    ctx: Context,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    ctx.signal.throwIfAborted();
    const bytes =
      (kind === 'comparison' ? POWER_LIMITS.comparisonBodyBytes : POWER_LIMITS.bodyBytes) +
      POWER_LIMITS.rowBytes;
    const active = [...this.producers];
    const total = active.reduce((sum, p) => sum + p.bytes, 0);
    const tenant = active
      .filter((p) => p.tenant === ctx.tenantId)
      .reduce((sum, p) => sum + p.bytes, 0);
    if (
      active.length >= POWER_LIMITS.producers ||
      total + bytes > POWER_LIMITS.processInflightBytes ||
      tenant + bytes > POWER_LIMITS.tenantInflightBytes
    )
      throw canvasError(
        'canvas_capacity_exhausted',
        'Producer memory or concurrency capacity is exhausted.',
      );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      ctx.signal,
      controller.signal,
      this.shutdownController.signal,
      AbortSignal.timeout(POWER_LIMITS.deadlineMs),
    ]);
    const { promise: settled, resolve: finish } = Promise.withResolvers<void>();
    const producer: Producer = {
      tenant: this.tenant(ctx),
      bytes,
      controller,
      settled,
    };
    this.producers.add(producer);
    try {
      return await run({ ...ctx, signal });
    } finally {
      this.producers.delete(producer);
      finish();
    }
  }

  /** Stage comparison summaries with observations only when the scientific envelope overflows. */
  presentComparison<T extends ComparisonDataset>(
    dataset: T,
    canvasId: string | undefined,
    ctx: Context,
    sourceTool: string,
  ) {
    if (this.fits({ ...dataset, rows: [], rowCount: dataset.rows.length, dataset: null }))
      return this.present(dataset, canvasId, ctx, sourceTool);
    const summaryRows = {
      buckets: dataset.summaries.map((summary, summaryIndex) => ({ ...summary, summaryIndex })),
      locations: dataset.locations
        .flatMap((location) =>
          location.summaries.map((summary) => ({ locationId: location.locationId, ...summary })),
        )
        .map((summary, summaryIndex) => ({ ...summary, summaryIndex })),
    };
    const strings = new Set([
      'parameter',
      'locationId',
      'units',
      'bucket',
      'method',
      'periodKind',
      'firstReturnedKey',
      'lastReturnedKey',
      'lastValidPeriodKey',
      'lastValidDate',
    ]);
    const booleans = new Set(['complete', 'windowClipped']);
    const tables: SummaryTable[] = (['buckets', 'locations'] as const).map((key) => {
      const rows = summaryRows[key];
      const names = new Set(rows.flatMap((row) => Object.keys(row)));
      return {
        key,
        table: `power_${randomUUID().replaceAll('-', '')}`,
        rows,
        columns: [...names].map((name) => ({
          name,
          type: strings.has(name)
            ? 'VARCHAR'
            : booleans.has(name)
              ? 'BOOLEAN'
              : name === 'summaryIndex'
                ? 'INTEGER'
                : 'DOUBLE',
          nullable: true,
        })),
      };
    });
    const compact = {
      ...dataset,
      summaries: dataset.summaries.slice(0, 1),
      locations: dataset.locations.map((location) => ({
        ...location,
        summaries: location.summaries.slice(0, 1),
        summaryCount: location.summaries.length,
      })),
    };
    return this.present(compact, canvasId, ctx, sourceTool, tables);
  }

  /** Preserve the scientific envelope with complete staging and bounded whole-row previews. */
  async present<T extends PresentableDataset>(
    dataset: T,
    canvasId: string | undefined,
    ctx: Context,
    sourceTool: string,
    related: SummaryTable[] = [],
  ): Promise<PresentedDataset<T>> {
    this.assertRunning();
    ctx.signal.throwIfAborted();
    const serialized = JSON.stringify(dataset.rows);
    const bytes = Buffer.byteLength(serialized);
    const relatedBytes = related.reduce(
      (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.rows)),
      0,
    );
    if (
      dataset.rows.length > POWER_LIMITS.rows ||
      bytes + relatedBytes > POWER_LIMITS.rowBytes ||
      related.some((item) => item.rows.length > POWER_LIMITS.rows) ||
      dataset.parameters.length > POWER_LIMITS.columns
    )
      throw powerError(
        'dataset_limit',
        'Normalized dataset exceeds the analytical workload limit.',
      );
    const inline = { ...dataset, rowCount: dataset.rows.length, dataset: null };
    if (!related.length && this.fits(inline)) return inline;
    if (!this.fits({ ...inline, rows: [] }))
      throw powerError(
        'dataset_limit',
        'Scientific metadata exceeds the complete response budget.',
      );
    const columns = this.columns(dataset);
    const table = `power_${randomUUID().replaceAll('-', '')}`;
    const handle = (
      id: string,
      expiresAt: string,
      name: string,
      rowCount: number,
      schema: ScientificColumn[],
    ) => ({
      canvas_id: id,
      table: name,
      rowCount,
      expiresAt,
      columns: schema.map((column) => ({ ...column, nullable: column.nullable ?? true })),
      describeTool: 'nasa_power_dataframe_describe' as const,
      queryTool: 'nasa_power_dataframe_query' as const,
    });
    const relatedHandles = (id: string, expiresAt: string) => {
      const buckets = related.find((item) => item.key === 'buckets');
      const locations = related.find((item) => item.key === 'locations');
      return buckets && locations
        ? {
            summaryDatasets: {
              buckets: handle(id, expiresAt, buckets.table, buckets.rows.length, buckets.columns),
              locations: handle(
                id,
                expiresAt,
                locations.table,
                locations.rows.length,
                locations.columns,
              ),
            },
          }
        : {};
    };
    const output = (id: string, expiresAt: string, preview: ObservationRow[]) => ({
      ...dataset,
      ...relatedHandles(id, expiresAt),
      rows: preview,
      rowCount: dataset.rows.length,
      dataset: handle(id, expiresAt, table, dataset.rows.length, columns),
    });
    const preview = this.preview(dataset.rows, (rows) =>
      output('0000000000', new Date(this.now()).toISOString(), rows),
    );
    const canvas = this.canvas;
    if (!canvas)
      throw canvasError(
        'canvas_required',
        'This complete dataset requires an analytical workspace.',
      );
    await this.reconcile();
    ctx.signal.throwIfAborted();
    const record = this.reserve(canvasId, ctx, table, bytes, columns, dataset, sourceTool, related);
    const expiry = (instance: CanvasInstance, info: TableInfo) =>
      new Date(
        Math.min(Date.parse(info.expiresAt ?? instance.expiresAt), Date.parse(instance.expiresAt)),
      ).toISOString();
    const operation = this.stage(
      canvas,
      record,
      table,
      dataset.rows,
      ctx,
      (instance, info) => {
        const references = relatedHandles(instance.canvasId, expiry(instance, info));
        for (const name of [table, ...related.map((item) => item.table)]) {
          const staged = this.registration(record, name);
          Object.assign(staged.provenance.envelope, references);
          const count =
            name === table
              ? dataset.rows.length
              : related.find((item) => item.table === name)?.rows.length;
          if (
            related.length > 0 &&
            !this.fits({
              canvas_id: instance.canvasId,
              expiresAt: instance.expiresAt,
              tables: [
                {
                  table: name,
                  rowCount: count,
                  expiresAt: expiry(instance, info),
                  columns: staged.columns,
                  provenance: staged.provenance,
                },
              ],
            })
          )
            throw powerError(
              'dataset_limit',
              'Complete single-table provenance exceeds the response budget.',
            );
        }
        if (!this.fits(output(instance.canvasId, expiry(instance, info), preview)))
          throw powerError(
            'dataset_limit',
            'The complete staged response exceeds the response budget.',
          );
      },
      related,
    );
    this.operations.add(operation);
    try {
      const { instance, info } = await operation;
      return output(instance.canvasId, expiry(instance, info), preview);
    } finally {
      this.operations.delete(operation);
    }
  }

  /** Inspect only the supplied canvas, including original scientific provenance. */
  describe(canvasId: string, input: { table?: string }, ctx: Context) {
    return this.operate(canvasId, ctx, async (instance, record) => {
      const tables = await instance.describe(input.table ? { tableName: input.table } : undefined);
      if (input.table && !tables.length)
        throw canvasError('missing_table', 'The requested table is absent.');
      const described = [];
      for (const info of tables) {
        const staged = record.tables.get(info.name);
        if (!staged || staged.cleanup) continue;
        ctx.signal.throwIfAborted();
        const provenance = await this.storage.get<Provenance>(this.key(record, info.name), ctx);
        ctx.signal.throwIfAborted();
        if (!provenance)
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            'Staged table provenance is unavailable.',
          );
        described.push({
          table: info.name,
          rowCount: info.rowCount,
          expiresAt: info.expiresAt ?? null,
          columns: info.columns.map((column) => {
            const scientific = staged.columns.find((item) => item.name === column.name);
            return {
              ...column,
              nullable: column.nullable ?? true,
              ...(scientific?.units === undefined ? {} : { units: scientific.units }),
              ...(scientific?.valueKind === undefined ? {} : { valueKind: scientific.valueKind }),
            };
          }),
          provenance,
        });
      }
      const output = { canvas_id: canvasId, expiresAt: instance.expiresAt, tables: described };
      if (!this.fits(output))
        throw canvasError(
          'query_limit',
          'Table provenance exceeds the complete response budget.',
          'Specify one table with nasa_power_dataframe_describe, or narrow the request to the producing tool and stage a smaller dataset.',
        );
      return output;
    });
  }

  /** Run one bounded read-only SELECT; cancellation waits for native completion. */
  async query(canvasId: string, input: { sql: string; rowLimit?: number }, ctx: Context) {
    if (
      input.sql.length > POWER_LIMITS.sqlCharacters ||
      (input.rowLimit !== undefined && (!Number.isInteger(input.rowLimit) || input.rowLimit < 1))
    )
      throw canvasError('query_limit', 'SQL length or row limit exceeds the query bound.');
    const rowLimit = Math.min(input.rowLimit ?? 100, POWER_LIMITS.queryRows);
    const notice =
      input.rowLimit !== undefined && input.rowLimit > rowLimit
        ? 'The effective row limit is 1000; larger requested limits are capped.'
        : undefined;
    if (this.queryCount >= POWER_LIMITS.queries)
      throw canvasError('canvas_capacity_exhausted', 'Analytical query concurrency is exhausted.');
    this.queryCount++;
    try {
      return await this.operate(canvasId, ctx, async (instance) => {
        const signal = AbortSignal.any([
          ctx.signal,
          this.shutdownController.signal,
          AbortSignal.timeout(POWER_LIMITS.queryMs),
        ]);
        const result = await instance.query(input.sql, {
          rowLimit,
          denySystemCatalogs: true,
          signal,
        });
        const output = QueryResultSchema.parse({
          canvas_id: canvasId,
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          shownCount: result.rows.length,
          truncated: result.truncated ?? false,
          countSemantics: result.truncated ? 'materialized_prefix' : 'exact',
        });
        if (!this.fits(output, notice))
          throw canvasError('query_limit', 'Projected SQL values exceed the response budget.');
        if (notice) ctx.enrich.notice(notice);
        return output;
      });
    } finally {
      this.queryCount--;
    }
  }

  /** Remove a table idempotently; a missing token has drop-specific guidance. */
  async drop(canvasId: string, input: { table: string }, ctx: Context) {
    if (!this.config.dataframeDropEnabled)
      throw new McpError(JsonRpcErrorCode.Forbidden, 'Explicit dataframe removal is disabled.');
    return await this.operate(
      canvasId,
      ctx,
      async (instance, record) => {
        const staged = record.tables.get(input.table);
        if (staged) staged.cleanup = true;
        const dropped = await instance.drop(input.table);
        await this.removeMetadata(record, input.table);
        if (record.tables.size === 0 && (await instance.describe()).length === 0) {
          await this.canvas?.drop(record.id, record.ctx);
          await this.confirmAbsent(record);
        }
        return { canvas_id: canvasId, table: input.table, dropped };
      },
      true,
    );
  }

  /** Reconcile bounded owned records without touching canvas or table TTL clocks. */
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.sweep().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }

  /** Stop admissions, settle owned work, then let framework teardown release natives. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.shutdownController.abort();
    for (const producer of this.producers) producer.controller.abort();
    await Promise.allSettled([...this.producers].map((producer) => producer.settled));
    await Promise.allSettled([...this.operations]);
    await this.reconciliation;
    await this.reconcile();
  }

  private assertRunning() {
    if (this.stopped)
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Analytical workspace is shutting down.',
      );
  }
  private tenant(ctx: Context): string {
    if (!ctx.tenantId)
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        'Tenant identity is required for analytical work.',
      );
    return ctx.tenantId;
  }
  private cleanContext(ctx: Context): Context {
    return { ...ctx, signal: new AbortController().signal };
  }
  private key(record: CanvasRecord, table: string) {
    return `power/canvas/${encodeURIComponent(record.tenant)}/${record.id}/${table}`;
  }

  private columns(dataset: PresentableDataset): ScientificColumn[] {
    const names = new Set<string>();
    for (const row of dataset.rows) for (const name of Object.keys(row)) names.add(name);
    const strings = new Set(['periodKey', 'periodKind', 'date', 'locationId', 'label', 'cellId']);
    const integers = new Set(['year', 'month', 'hour']);
    const required = new Set(['periodKey', 'periodKind', 'cellId', 'locationId']);
    const schema = [...names].map((name) => {
      const parameter = dataset.parameters.find((item) => item.code === name);
      const type =
        strings.has(name) || parameter?.valueKind === 'orientation'
          ? 'VARCHAR'
          : integers.has(name)
            ? 'INTEGER'
            : 'DOUBLE';
      return {
        name,
        type,
        nullable: !required.has(name),
        ...(parameter ? { units: parameter.units, valueKind: parameter.valueKind } : {}),
      } satisfies ScientificColumn;
    });
    for (const row of dataset.rows)
      for (const column of schema) {
        const value = row[column.name];
        if (
          ((value === null || value === undefined) && !column.nullable) ||
          (value !== null &&
            value !== undefined &&
            ((column.type === 'DOUBLE' && (typeof value !== 'number' || !Number.isFinite(value))) ||
              (column.type === 'INTEGER' &&
                (typeof value !== 'number' || !Number.isInteger(value))) ||
              (column.type === 'VARCHAR' && typeof value !== 'string')))
        )
          throw new McpError(
            JsonRpcErrorCode.SerializationError,
            'Observation value does not match its explicit scientific column type.',
          );
      }
    return schema;
  }

  private fits(output: object, notice?: string): boolean {
    return (
      JSON.stringify(notice === undefined ? output : { ...output, notice }).length <=
        POWER_LIMITS.inlineCharacters &&
      formatFaithfully(output).reduce((sum, block) => sum + block.text.length, 0) +
        (notice === undefined ? 0 : `\n\n> ${notice}`.length) <=
        POWER_LIMITS.inlineCharacters
    );
  }

  private preview(
    rows: ObservationRow[],
    output: (preview: ObservationRow[]) => object,
  ): ObservationRow[] {
    for (let count = Math.min(20, rows.length); count > 0; count--) {
      const preview = rows.slice(0, count);
      if (this.fits(output(preview))) return preview;
    }
    throw powerError(
      'dataset_limit',
      'Scientific metadata and one complete observation exceed the response budget.',
    );
  }

  private reserve<T extends PresentableDataset>(
    id: string | undefined,
    ctx: Context,
    table: string,
    bytes: number,
    columns: ScientificColumn[],
    dataset: T,
    sourceTool: string,
    related: SummaryTable[] = [],
  ): CanvasRecord {
    this.assertRunning();
    const records = [...this.records.values()];
    let record = id ? this.records.get(id) : undefined;
    if (id && (!record || record.tenant !== ctx.tenantId || record.pending))
      throw canvasError('canvas_not_found', 'Canvas not found or expired.');
    const retained = (items: CanvasRecord[]) =>
      items.reduce(
        (sum, item) =>
          sum + [...item.tables.values()].reduce((subtotal, entry) => subtotal + entry.bytes, 0),
        0,
      );
    const tenantRecords = records.filter((item) => item.tenant === ctx.tenantId);
    const relatedBytes = related.reduce(
      (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.rows)),
      0,
    );
    if (
      !record &&
      (records.length >= POWER_LIMITS.canvasesPerProcess ||
        tenantRecords.length >= POWER_LIMITS.canvasesPerTenant)
    )
      throw canvasError(
        'canvas_capacity_exhausted',
        'The process or tenant canvas-count limit is exhausted.',
        this.config.dataframeDropEnabled
          ? 'Reuse an explicit live canvas_id, drop all tables from a canvas, or wait for canvas expiry.'
          : 'Reuse an explicit live canvas_id, or wait for canvas expiry.',
      );
    if (
      retained(records) + bytes + relatedBytes > POWER_LIMITS.processRetainedBytes ||
      retained(tenantRecords) + bytes + relatedBytes > POWER_LIMITS.tenantRetainedBytes ||
      (record &&
        (record.busy || record.tables.size + 1 + related.length > POWER_LIMITS.tablesPerCanvas))
    )
      throw canvasError(
        'canvas_capacity_exhausted',
        'Analytical workspace memory or table capacity is exhausted.',
      );
    const { rows: _rows, ...envelope } = dataset;
    const provenance = ProvenanceSchema.parse({
      sourceTool,
      envelope: JSON.parse(JSON.stringify(envelope)),
      createdAt: new Date(this.now()).toISOString(),
    });
    record ??= {
      id: randomUUID(),
      tenant: this.tenant(ctx),
      ctx: this.cleanContext(ctx),
      created: this.now(),
      busy: false,
      pending: true,
      tables: new Map(),
    };
    record.busy = true;
    record.tables.set(table, { bytes, columns, provenance, cleanup: true });
    for (const item of related)
      record.tables.set(item.table, {
        bytes: Buffer.byteLength(JSON.stringify(item.rows)),
        columns: item.columns,
        provenance: ProvenanceSchema.parse(provenance),
        cleanup: true,
      });
    this.records.set(record.id, record);
    return record;
  }

  private async stage(
    canvas: DataCanvas,
    record: CanvasRecord,
    table: string,
    rows: ObservationRow[],
    ctx: Context,
    validate: (instance: CanvasInstance, info: TableInfo) => void,
    related: SummaryTable[] = [],
  ): Promise<{ instance: CanvasInstance; info: TableInfo }> {
    let instance: CanvasInstance | undefined;
    const registrations = [{ table, rows }, ...related];
    const started = new Set<string>();
    let finalizing = false;
    let info: TableInfo | undefined;
    try {
      instance = await canvas.acquire(record.pending ? undefined : record.id, ctx, {
        signal: ctx.signal,
      });
      if (record.pending) {
        this.records.delete(record.id);
        record.id = instance.canvasId;
        record.pending = false;
        this.records.set(record.id, record);
      }
      if ((await instance.describe()).some((info) => info.name === table))
        throw new McpError(
          JsonRpcErrorCode.Conflict,
          'Generated analytical table name already exists.',
        );
      for (const registration of registrations) {
        const entry = this.registration(record, registration.table);
        const schema: ColumnSchema[] = entry.columns.map(({ name, type, nullable }) => ({
          name,
          type,
          nullable: nullable ?? true,
        }));
        started.add(registration.table);
        await instance.registerTable(registration.table, registration.rows, {
          schema,
          ttlMs: POWER_LIMITS.tableTtlMs,
          signal: ctx.signal,
        });
        ctx.signal.throwIfAborted();
        const registered = (await instance.describe({ tableName: registration.table }))[0];
        if (!registered || registered.rowCount !== registration.rows.length)
          throw new McpError(
            JsonRpcErrorCode.DatabaseError,
            'Registered table does not contain the complete dataset.',
          );
        if (registration.table === table) info = registered;
      }
      if (!info) throw new Error('Missing registered observation table');
      finalizing = true;
      validate(instance, info);
      finalizing = false;
      for (const registration of registrations) {
        const entry = this.registration(record, registration.table);
        await this.storage.set(this.key(record, registration.table), entry.provenance, ctx, {
          ttl: POWER_LIMITS.canvasAbsoluteTtlMs / 1_000,
        });
        ctx.signal.throwIfAborted();
      }
      for (const registration of registrations)
        this.registration(record, registration.table).cleanup = false;
      return { instance, info };
    } catch (error) {
      if (!instance) {
        if (record.pending) this.records.delete(record.id);
      } else {
        for (const registration of registrations) {
          try {
            if (started.has(registration.table))
              await this.canvas?.getProvider().drop(record.id, registration.table, record.ctx);
            await this.removeMetadata(record, registration.table);
          } catch (cleanupError) {
            record.ctx.log.error(
              'Analytical table cleanup deferred; reservations retained.',
              cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
            );
          }
        }
        try {
          if (instance.isNew && record.tables.size === 0) {
            await canvas.drop(record.id, record.ctx);
            await this.confirmAbsent(record);
          }
        } catch (cleanupError) {
          record.ctx.log.error(
            'Analytical registration cleanup deferred; reservations retained.',
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          );
        }
      }
      if (finalizing) throw error;
      safeCanvasError(error);
    } finally {
      record.busy = false;
    }
  }

  private registration(record: CanvasRecord, table: string): TableRecord {
    const entry = record.tables.get(table);
    if (!entry) throw new Error('Missing reserved registration');
    return entry;
  }

  private async operate<T>(
    id: string,
    ctx: Context,
    run: (instance: CanvasInstance, record: CanvasRecord) => Promise<T>,
    drop = false,
  ): Promise<T> {
    this.assertRunning();
    ctx.signal.throwIfAborted();
    const canvas = this.canvas;
    if (!canvas) throw canvasError('canvas_unavailable', 'Analytical workspace is not enabled.');
    const record = this.records.get(id);
    if (!record || record.tenant !== ctx.tenantId || record.pending)
      throw canvasError(
        'canvas_not_found',
        'Canvas not found or expired.',
        drop ? 'The canvas has expired or is absent; there is nothing left to remove.' : undefined,
      );
    if (record.busy)
      throw canvasError('canvas_capacity_exhausted', 'Another operation is active on this canvas.');
    record.busy = true;
    const operation = (async () => {
      try {
        return await run(await canvas.acquire(id, ctx, { signal: ctx.signal }), record);
      } catch (error) {
        safeCanvasError(error, drop);
      } finally {
        record.busy = false;
      }
    })();
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }

  private async removeMetadata(record: CanvasRecord, table: string) {
    await this.storage.delete(this.key(record, table), record.ctx);
    record.tables.delete(table);
  }
  private async confirmAbsent(record: CanvasRecord) {
    try {
      await this.canvas?.getProvider().describe(record.id, record.ctx);
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'canvas_not_found') {
        for (const table of record.tables.keys()) await this.removeMetadata(record, table);
        this.records.delete(record.id);
        return;
      }
      throw error;
    }
  }
  private async sweep() {
    if (!this.canvas) return;
    for (const record of this.records.values()) {
      if (record.busy || record.pending) continue;
      record.busy = true;
      try {
        const provider = this.canvas.getProvider();
        let actual: TableInfo[];
        try {
          actual = await provider.describe(record.id, record.ctx);
        } catch (error) {
          if (!(error instanceof McpError) || error.data?.reason !== 'canvas_not_found')
            throw error;
          for (const table of record.tables.keys()) await this.removeMetadata(record, table);
          this.records.delete(record.id);
          continue;
        }
        for (const [table, staged] of record.tables) {
          if (staged.cleanup && actual.some((info) => info.name === table)) {
            await provider.drop(record.id, table, record.ctx);
            actual = await provider.describe(record.id, record.ctx);
          }
          if (!actual.some((info) => info.name === table)) await this.removeMetadata(record, table);
        }
        if (
          (record.tables.size === 0 && actual.length === 0) ||
          this.now() - record.created >= POWER_LIMITS.canvasAbsoluteTtlMs
        ) {
          await this.canvas.drop(record.id, record.ctx);
          await provider.destroyCanvas(record.id, record.ctx);
          await this.confirmAbsent(record);
        }
      } catch (error) {
        record.ctx.log.error(
          'Analytical reconciliation deferred; reservations retained.',
          error instanceof Error ? error : new Error(String(error)),
        );
      } finally {
        record.busy = false;
      }
    }
  }
}

/** Construct an isolated service instance for setup or boundary tests. */
export function createCanvasService(options: CanvasServiceOptions): CanvasService {
  return new CanvasService(options);
}
let service: CanvasService | undefined;
/** Install the process workspace during runtime setup. */
export function initCanvasService(options: CanvasServiceOptions): CanvasService {
  service = createCanvasService(options);
  return service;
}
/** Resolve the initialized workspace at request time. */
export function getCanvasService(): CanvasService {
  if (!service) throw new Error('CanvasService is not initialized');
  return service;
}
