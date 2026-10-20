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
  type PresentableDataset,
  type PresentedDataset,
  type Provenance,
  ProvenanceSchema,
  QueryResultSchema,
  type ScientificColumn,
} from './types.js';

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
  retireWhenEmpty: boolean;
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

  /** Preserve the complete scientific envelope, staging full rows only on overflow. */
  async present<T extends PresentableDataset>(
    dataset: T,
    canvasId: string | undefined,
    ctx: Context,
    sourceTool: string,
  ): Promise<PresentedDataset<T>> {
    this.assertRunning();
    ctx.signal.throwIfAborted();
    const serialized = JSON.stringify(dataset.rows);
    const bytes = Buffer.byteLength(serialized);
    if (
      dataset.rows.length > POWER_LIMITS.rows ||
      bytes > POWER_LIMITS.rowBytes ||
      dataset.parameters.length > POWER_LIMITS.columns
    )
      throw powerError(
        'dataset_limit',
        'Normalized dataset exceeds the analytical workload limit.',
      );
    const inline = { ...dataset, rowCount: dataset.rows.length, dataset: null };
    if (this.fits(inline)) return inline;
    if (!this.fits({ ...inline, rows: [] }))
      throw powerError(
        'dataset_limit',
        'Scientific metadata exceeds the complete response budget.',
      );
    const columns = this.columns(dataset);
    const table = `power_${randomUUID().replaceAll('-', '')}`;
    const output = (id: string, expiresAt: string, preview: ObservationRow[]) => ({
      ...dataset,
      rows: preview,
      rowCount: dataset.rows.length,
      dataset: {
        canvas_id: id,
        table,
        rowCount: dataset.rows.length,
        expiresAt,
        columns: columns.map((column) => ({ ...column, nullable: column.nullable ?? true })),
        describeTool: 'nasa_power_dataframe_describe' as const,
        queryTool: 'nasa_power_dataframe_query' as const,
      },
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
    const record = this.reserve(canvasId, ctx, table, bytes, columns, dataset, sourceTool);
    const expiry = (instance: CanvasInstance, info: TableInfo) =>
      new Date(
        Math.min(Date.parse(info.expiresAt ?? instance.expiresAt), Date.parse(instance.expiresAt)),
      ).toISOString();
    const operation = this.stage(canvas, record, table, dataset.rows, ctx, (instance, info) => {
      if (!this.fits(output(instance.canvasId, expiry(instance, info), preview)))
        throw powerError(
          'dataset_limit',
          'The complete staged response exceeds the response budget.',
        );
    });
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
      (input.rowLimit !== undefined &&
        (!Number.isInteger(input.rowLimit) ||
          input.rowLimit < 1 ||
          input.rowLimit > POWER_LIMITS.queryRows))
    )
      throw canvasError('query_limit', 'SQL length or row limit exceeds the query bound.');
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
          rowLimit: input.rowLimit ?? 100,
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
        if (!this.fits(output))
          throw canvasError('query_limit', 'Projected SQL values exceed the response budget.');
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

  private fits(output: object): boolean {
    return (
      JSON.stringify(output).length <= POWER_LIMITS.inlineCharacters &&
      formatFaithfully(output).reduce((sum, block) => sum + block.text.length, 0) <=
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
    if (
      retained(records) + bytes > POWER_LIMITS.processRetainedBytes ||
      retained(tenantRecords) + bytes > POWER_LIMITS.tenantRetainedBytes ||
      (record && (record.busy || record.tables.size >= POWER_LIMITS.tablesPerCanvas)) ||
      (!record &&
        (records.length >= POWER_LIMITS.canvasesPerProcess ||
          tenantRecords.length >= POWER_LIMITS.canvasesPerTenant))
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
      retireWhenEmpty: false,
      tables: new Map(),
    };
    record.busy = true;
    record.tables.set(table, { bytes, columns, provenance, cleanup: true });
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
  ): Promise<{ instance: CanvasInstance; info: TableInfo }> {
    let instance: CanvasInstance | undefined;
    let registrationStarted = false;
    let finalizing = false;
    const staged = record.tables.get(table);
    if (!staged) throw new Error('Missing reserved registration');
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
      const schema: ColumnSchema[] = staged.columns.map(({ name, type, nullable }) => ({
        name,
        type,
        nullable: nullable ?? true,
      }));
      registrationStarted = true;
      await instance.registerTable(table, rows, {
        schema,
        ttlMs: POWER_LIMITS.tableTtlMs,
        signal: ctx.signal,
      });
      ctx.signal.throwIfAborted();
      await this.storage.set(this.key(record, table), staged.provenance, ctx, {
        ttl: POWER_LIMITS.canvasAbsoluteTtlMs / 1_000,
      });
      ctx.signal.throwIfAborted();
      const info = (await instance.describe({ tableName: table }))[0];
      if (!info || info.rowCount !== rows.length)
        throw new McpError(
          JsonRpcErrorCode.DatabaseError,
          'Registered table does not contain the complete dataset.',
        );
      finalizing = true;
      validate(instance, info);
      staged.cleanup = false;
      return { instance, info };
    } catch (error) {
      if (!instance) {
        if (record.pending) this.records.delete(record.id);
      } else {
        if (instance.isNew) record.retireWhenEmpty = true;
        try {
          if (registrationStarted)
            await this.canvas?.getProvider().drop(record.id, table, record.ctx);
          await this.removeMetadata(record, table);
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
          (record.retireWhenEmpty && record.tables.size === 0) ||
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
