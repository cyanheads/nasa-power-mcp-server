/** @fileoverview Fixed-origin NASA POWER client with bounded shared pacing/cache. @module services/power/power-service */
import type { Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  ErrorHandler,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, POWER_LIMITS, type ServerConfig } from '../../config/server-config.js';
import { normalizeDesignConditions, resolveDesignYears } from './design-conditions.js';
import {
  describePowerError,
  powerError,
  REFERENCE_LIMIT_RECOVERY,
  shapeError,
  windowError,
} from './errors.js';
import {
  normalizePoint,
  normalizeRegion,
  PointPayloadSchema,
  RegionPayloadSchema,
  requestedParameters,
} from './normalize.js';
import { TILTED_ALIAS } from './presets.js';
import {
  type Community,
  type DesignConditions,
  DesignConditionsPayloadSchema,
  type DesignConditionsRequest,
  DesignConditionsRequestSchema,
  IndicatorsConfigurationSchema,
  type ParameterDictionary,
  ParameterDictionarySchema,
  type PowerConfiguration,
  PowerConfigurationSchema,
  type PowerDataset,
  type PowerRequest,
  PowerRequestSchema,
  type RegionalDataset,
  type RegionRequest,
  RegionRequestSchema,
  type Resolution,
} from './types.js';
import { unservedParameters } from './unserved-parameters.js';

/** One producing operation owns this shared attempt/decoded-byte budget. */
export type PowerCallBudget = {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly maxBodyBytes: number;
  readonly comparison: boolean;
  attempts: number;
  /** Body bytes decoded by every attempt, discarded ones included; the comparison ceiling bounds it. */
  decodedBytes: number;
  /** Body bytes of the responses the call still holds; a failed attempt's body leaves it at once. */
  heldBytes: number;
};
/** Injection boundaries for offline fixtures and deterministic access timestamps. */
export type PowerServiceOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  config?: ServerConfig;
};
/** Provenance POWER sends only as response headers: the Indicators API's version and sources. */
type SourceHeaders = { appVersion?: string; dataSources?: string };
/** A cached body keeps its response headers, so a cache hit reports the same provenance. */
type Cached = {
  value: unknown;
  fetchedAt: string;
  headers: SourceHeaders;
  expiresAt: number;
  bytes: number;
};
function sourceHeaders(response: Response): SourceHeaders {
  const appVersion = response.headers.get('x-app-version');
  const dataSources = response.headers.get('x-data-sources');
  return {
    ...(appVersion !== null && { appVersion }),
    ...(dataSources !== null && { dataSources }),
  };
}
const origin = 'https://power.larc.nasa.gov';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw shapeError(
      `NASA POWER response shape is invalid: ${result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  return result.data;
}
/** Source service; one production instance owns the upstream queue and LRU. */
export class PowerService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly pacer = createPacer({
    name: 'nasa-power',
    maxConcurrent: 1,
    minStartGapMs: POWER_LIMITS.startGapMs,
    maxQueueDepth: POWER_LIMITS.queueDepth,
    cooldown: { baseMs: 2_000, maxMs: 86_400_000 },
  });
  private readonly shutdown = new AbortController();
  private readonly cache = new Map<string, Cached>();
  private cacheBytes = 0;
  readonly config: ServerConfig;
  constructor(options: PowerServiceOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.config = options.config ?? getServerConfig();
  }
  /**
   * Start before dictionaries/configuration, then pass the same object through all locations and
   * canvas presentation. `deadlineMs` is what remains of a deadline that started earlier (a
   * producer's tool entry); it defaults to the full call deadline. `onHeldBytes` receives the body
   * bytes the call holds after every streamed chunk, so a producer can grow its in-flight
   * reservation, or abort the call, before the next chunk is read; it receives the lower total
   * again when a failed attempt's body is released, before any retry reads.
   */
  createCallBudget(
    ctx: Context,
    comparison = false,
    options: { deadlineMs?: number; onHeldBytes?: (total: number) => void } = {},
  ): PowerCallBudget {
    const deadlineMs = options.deadlineMs ?? POWER_LIMITS.deadlineMs;
    let heldBytes = 0;
    return {
      deadlineAt: this.now() + deadlineMs,
      signal: AbortSignal.any([ctx.signal, this.shutdown.signal, AbortSignal.timeout(deadlineMs)]),
      maxAttempts: comparison ? POWER_LIMITS.comparisonAttempts : 6,
      maxBodyBytes: comparison ? POWER_LIMITS.comparisonBodyBytes : POWER_LIMITS.bodyBytes,
      comparison,
      attempts: 0,
      decodedBytes: 0,
      get heldBytes() {
        return heldBytes;
      },
      set heldBytes(total: number) {
        heldBytes = total;
        options.onHeldBytes?.(total);
      },
    };
  }
  /** Abort owned work, remove queued callers, and release bounded cached payloads. */
  dispose(): void {
    this.shutdown.abort();
    this.pacer.dispose();
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private remaining(budget: PowerCallBudget): number {
    budget.signal.throwIfAborted();
    const remaining = budget.deadlineAt - this.now();
    if (remaining <= 0)
      throw new McpError(JsonRpcErrorCode.Timeout, 'NASA POWER call deadline exceeded.');
    return remaining;
  }
  private cached(key: string): Cached | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.cacheBytes -= entry.bytes;
      return undefined;
    }
    this.cache.set(key, entry);
    return entry;
  }
  private store(key: string, entry: Omit<Cached, 'expiresAt'>, ttl: number): void {
    const { value, bytes } = entry;
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cacheBytes -= previous.bytes;
    }
    if (bytes > POWER_LIMITS.cacheBytes) return;
    while (
      this.cache.size >= POWER_LIMITS.cacheEntries ||
      this.cacheBytes + bytes > POWER_LIMITS.cacheBytes
    ) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bytes;
    }
    this.cache.set(key, {
      ...entry,
      value: structuredClone(value),
      expiresAt: this.now() + ttl,
    });
    this.cacheBytes += bytes;
  }
  /** Stream one body under the byte bounds; a body that fails to read leaves `heldBytes` again. */
  private async body(
    response: Response,
    signal: AbortSignal,
    budget: PowerCallBudget,
  ): Promise<{ text: string; bytes: number }> {
    if (!response.body) return { text: '', bytes: 0 };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        budget.decodedBytes += next.value.byteLength;
        budget.heldBytes += next.value.byteLength;
        if (
          bytes > POWER_LIMITS.bodyBytes ||
          (budget.comparison && budget.decodedBytes > budget.maxBodyBytes)
        ) {
          await reader.cancel();
          throw powerError('dataset_limit', 'NASA POWER decoded response exceeds the byte budget.');
        }
        try {
          text += decoder.decode(next.value, { stream: true });
        } catch {
          throw shapeError('NASA POWER returned invalid UTF-8.');
        }
      }
      try {
        text += decoder.decode();
      } catch {
        throw shapeError('NASA POWER returned invalid UTF-8.');
      }
      return { text, bytes };
    } catch (error) {
      budget.heldBytes -= bytes;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  /** Classify a non-2xx or non-JSON body, or parse a JSON body against `schema`. */
  private decode<T>(response: Response, text: string, schema: z.ZodType<T>): T {
    if (!response.ok) {
      let diagnostics: unknown;
      try {
        diagnostics = JSON.parse(text);
      } catch {
        diagnostics = text.slice(0, 4_096);
      }
      const messages =
        diagnostics &&
        typeof diagnostics === 'object' &&
        'messages' in diagnostics &&
        Array.isArray(diagnostics.messages)
          ? diagnostics.messages
              .filter((message) => typeof message === 'string')
              .map((message) => message.slice(0, 2_048))
              .slice(0, 20)
          : [text.slice(0, 4_096)];
      const data = { status: response.status, messages };
      if (response.status === 429)
        throw powerError('upstream_rate_limited', 'NASA POWER rate limited this request.', {
          ...data,
          retryAfter: response.headers.get('retry-after') ?? '2',
        });
      if (response.status === 422 || response.status === 400)
        throw powerError('upstream_rejected', 'NASA POWER rejected the request.', data);
      const code =
        response.status === 401
          ? JsonRpcErrorCode.Unauthorized
          : response.status === 403
            ? JsonRpcErrorCode.Forbidden
            : response.status === 404
              ? JsonRpcErrorCode.NotFound
              : [408, 425, 504].includes(response.status)
                ? JsonRpcErrorCode.Timeout
                : response.status >= 500
                  ? JsonRpcErrorCode.ServiceUnavailable
                  : JsonRpcErrorCode.ValidationError;
      throw new McpError(
        code,
        describePowerError(`NASA POWER HTTP ${response.status}.`, data),
        data,
      );
    }
    if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(text))
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'NASA POWER returned an HTML error page.',
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw shapeError('NASA POWER returned malformed JSON.');
    }
    return parse(schema, raw);
  }
  private async load<T>(
    url: URL,
    schema: z.ZodType<T>,
    ctx: Context,
    budget: PowerCallBudget,
    ttl: number,
  ): Promise<{ value: T; fetchedAt: string; cacheHit: boolean; headers: SourceHeaders }> {
    this.remaining(budget);
    const key = url.toString();
    const hit = this.cached(key);
    if (hit)
      return {
        value: structuredClone(hit.value) as T,
        fetchedAt: hit.fetchedAt,
        cacheHit: true,
        headers: hit.headers,
      };
    const maxRetries = 1;
    /** The last transient failure withRetry judged, which a retry-exhausted wrapper carries as its cause. */
    let failure: unknown;
    try {
      return await withRetry(
        ({ signal }) => {
          this.remaining(budget);
          if (budget.attempts >= budget.maxAttempts)
            throw new McpError(
              JsonRpcErrorCode.Timeout,
              'NASA POWER shared attempt budget exhausted.',
              { retryable: false },
            );
          return this.pacer.run(
            async () => {
              this.remaining(budget);
              if (budget.attempts >= budget.maxAttempts)
                throw new McpError(
                  JsonRpcErrorCode.Timeout,
                  'NASA POWER shared attempt budget exhausted.',
                  { retryable: false },
                );
              budget.attempts++;
              const attemptSignal = AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.min(POWER_LIMITS.attemptMs, this.remaining(budget))),
              ]);
              let response: Response;
              try {
                response = await this.fetcher(url, {
                  signal: attemptSignal,
                  redirect: 'error',
                  headers: { Accept: 'application/json' },
                });
              } catch (error) {
                if (signal.aborted) throw signal.reason;
                if (attemptSignal.aborted)
                  throw new McpError(
                    JsonRpcErrorCode.Timeout,
                    'NASA POWER fetch attempt timed out.',
                  );
                throw new McpError(
                  JsonRpcErrorCode.ServiceUnavailable,
                  'NASA POWER network request failed.',
                  {},
                  { cause: error },
                );
              }
              const { text, bytes } = await this.body(response, attemptSignal, budget);
              let value: T;
              try {
                this.remaining(budget);
                value = this.decode(response, text, schema);
                this.remaining(budget);
              } catch (error) {
                /** A failed attempt's body is discarded, so the call no longer holds it. */
                budget.heldBytes -= bytes;
                throw error;
              }
              const fetchedAt = new Date(this.now()).toISOString();
              const headers = sourceHeaders(response);
              this.store(key, { value, fetchedAt, headers, bytes }, ttl);
              ctx.log.debug('NASA POWER response received', { bytes, cacheHit: false });
              return { value, fetchedAt, cacheHit: false, headers };
            },
            { signal, maxWaitMs: Math.min(POWER_LIMITS.queueWaitMs, this.remaining(budget)) },
          );
        },
        {
          maxRetries,
          baseDelayMs: 1_000,
          deadlineMs: this.remaining(budget),
          signal: budget.signal,
          operation: 'PowerService.load',
          context: ctx,
          isTransient: (error) => {
            failure = error;
            return (
              !(error instanceof McpError && error.data?.reason === 'upstream_rate_limited') &&
              defaultIsTransient(error)
            );
          },
        },
      );
    } catch (error) {
      if (
        error instanceof McpError &&
        error.data?.reason === 'dataset_limit' &&
        (url.pathname === '/api/system/manager/parameters' ||
          url.pathname.endsWith('/configuration'))
      )
        throw powerError('dataset_limit', error.message, {
          ...error.data,
          recovery: { hint: REFERENCE_LIMIT_RECOVERY },
        });
      if (error instanceof McpError && error.data?.reason === 'pacer_shed')
        throw powerError('request_queue_full', 'NASA POWER request scheduling capacity is full.', {
          retryAfter: error.data.retryAfter,
        });
      /** The retry clock and the budget's timeout expire together; either way the call's deadline passed. */
      if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded')
        throw new McpError(
          JsonRpcErrorCode.Timeout,
          'NASA POWER call deadline exceeded.',
          undefined,
          { cause: error },
        );
      /**
       * Once retries run out, withRetry wraps the last attempt's failure: it appends "(failed after
       * N attempts)" to that message, which would land on NASA's own text, adds its internal
       * `operation` label to an McpError, and records no attempt count on any other error. Rebuild
       * from that attempt, whatever its type, keeping the code it carries or classifies as, and
       * state the count as its own fact.
       */
      if (
        failure instanceof Error &&
        error instanceof Error &&
        error !== failure &&
        error.cause === failure
      ) {
        /** A wrapper exists only once the last attempt failed. */
        const retryAttempts = maxRetries + 1;
        throw new McpError(
          failure instanceof McpError ? failure.code : ErrorHandler.determineErrorCode(failure),
          describePowerError(failure.message, { retryAttempts }),
          { ...(failure instanceof McpError ? failure.data : {}), retryAttempts },
          { cause: error },
        );
      }
      throw error;
    }
  }
  /** Complete dictionary for one exact community/resolution pair. */
  async dictionary(
    community: Community,
    resolution: Resolution,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<ParameterDictionary> {
    const url = new URL('/api/system/manager/parameters', origin);
    url.searchParams.set('community', community);
    url.searchParams.set('temporal', resolution);
    return (
      await this.load(url, ParameterDictionarySchema, ctx, budget, POWER_LIMITS.referenceTtlMs)
    ).value;
  }
  /** Source product coverage and available output formats. */
  async configuration(
    resolution: Resolution,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<PowerConfiguration> {
    return (
      await this.load(
        new URL(`/api/temporal/${resolution}/configuration`, origin),
        PowerConfigurationSchema,
        ctx,
        budget,
        POWER_LIMITS.referenceTtlMs,
      )
    ).value;
  }
  /**
   * The window checkable before any request: the product floor through today's UTC date, or
   * 1981 through the current year. Climatology's real end exists only in its configuration.
   */
  private localWindow(resolution: Resolution): { start: string; end: string } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return resolution === 'daily' || resolution === 'hourly'
      ? { start: resolution === 'hourly' ? '2001-01-01' : '1981-01-01', end: today }
      : { start: '1981', end: today.slice(0, 4) };
  }
  private validateWindow(request: PowerRequest | RegionRequest): void {
    const { start, end } = this.localWindow(request.temporalResolution);
    if (request.temporalResolution === 'daily' || request.temporalResolution === 'hourly') {
      const reversed = request.endDate < request.startDate;
      if (reversed || request.startDate < start || request.endDate > end)
        throw windowError(
          request.temporalResolution,
          start,
          end,
          reversed ? 'with startDate on or before endDate' : undefined,
        );
    } else if (request.temporalResolution === 'monthly') {
      const reversed = request.endYear < request.startYear;
      if (reversed || request.endYear > Number(end))
        throw windowError(
          'monthly',
          start,
          end,
          reversed ? 'with startYear on or before endYear' : undefined,
        );
    } else if ('latitude' in request) {
      if ((request.startYear === undefined) !== (request.endYear === undefined))
        throw powerError(
          'invalid_window',
          'Climatology startYear and endYear must be sent together.',
          {
            recovery: {
              hint: 'Send both startYear and endYear, or omit both to use the source product range.',
            },
          },
        );
      /** NASA computes a climatology over two or more calendar years and answers 422 below that. */
      if (
        request.startYear !== undefined &&
        request.endYear !== undefined &&
        request.startYear >= request.endYear
      )
        throw powerError(
          'invalid_window',
          'Climatology years must span at least two calendar years, with startYear before endYear.',
          {
            recovery: {
              hint: 'Resend with endYear after startYear, or omit both years to use the source product range.',
            },
          },
        );
    }
  }
  /** Validate shared scientific inputs and references without fetching observations. */
  async validateRequest(
    request: PowerRequest | RegionRequest,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<void> {
    await this.prepare(
      'latitude' in request
        ? PowerRequestSchema.parse(request)
        : RegionRequestSchema.parse(request),
      ctx,
      budget,
    );
  }
  private async prepare(
    request: PowerRequest | RegionRequest,
    ctx: Context,
    budget: PowerCallBudget,
  ): Promise<string[]> {
    this.validateWindow(request);
    if ('selection' in request) {
      if (
        request.selection.mode === 'preset' &&
        request.selection.preset === 'building_hvac' &&
        request.temporalResolution === 'hourly'
      )
        throw powerError('unsupported_preset', 'building_hvac is unavailable hourly.');
      const windPaired =
        (request.windElevation === undefined) === (request.windSurface === undefined);
      const selected = requestedParameters(request);
      if (
        !windPaired ||
        (selected.includes('WSC') &&
          (request.windElevation === undefined || request.windSurface === undefined))
      )
        throw powerError(
          'invalid_correction',
          'WSC requires windElevation and windSurface together.',
        );
      if (selected.includes('PSC') && request.siteElevation === undefined)
        throw powerError('invalid_correction', 'PSC requires siteElevation.', {
          recovery: { hint: 'Supply siteElevation for PSC, or remove PSC from parameters.' },
        });
    } else {
      const latSpan = request.latitudeMax - request.latitudeMin;
      const lonSpan = request.longitudeMax - request.longitudeMin;
      if (latSpan < 2 || latSpan > 10 || lonSpan < 2 || lonSpan > 10)
        throw powerError('invalid_region', 'Each ordered regional axis must span 2 to 10 degrees.');
      if (request.parameter === 'PSC' || request.parameter === 'WSC')
        throw powerError(
          'invalid_correction',
          `Regional requests do not support ${request.parameter}, a point-only correction.`,
          {
            recovery: {
              hint:
                request.parameter === 'WSC'
                  ? 'Request WS10M or WS50M for the region, or use nasa_power_get_timeseries or nasa_power_get_climatology with windElevation and windSurface at a point.'
                  : 'Request PS for the region, or use nasa_power_get_timeseries or nasa_power_get_climatology with siteElevation at a point.',
            },
          },
        );
    }
    const codes = requestedParameters(request);
    const parameterLimit = request.temporalResolution === 'hourly' ? 15 : 20;
    if (codes.length > parameterLimit)
      throw powerError(
        'unsupported_parameter',
        `Effective parameter count ${codes.length} exceeds the ${parameterLimit}-code ${request.temporalResolution} limit.`,
        {
          count: codes.length,
          limit: parameterLimit,
          recovery: {
            hint: `Reduce the selection to at most ${parameterLimit} effective codes, including any added PSC and WSC corrections, then retry.`,
          },
        },
      );
    const unserved = unservedParameters(codes, request.temporalResolution);
    if (unserved)
      throw powerError(
        'unsupported_parameter',
        `NASA POWER lists ${unserved.parameters.join(', ')} for ${request.temporalResolution} but does not serve ${unserved.parameters.length === 1 ? 'it' : 'them'} at that resolution.`,
        { parameters: unserved.parameters, recovery: { hint: unserved.recovery } },
      );
    /**
     * Configuration first: its ~0.3 KB body settles the configured window before the dictionary
     * (up to ~0.6 MB) is read, and every successful call needs both. Only climatology compares its
     * end with the configuration; the other products end at today or the current month, which the
     * local check reads without the up-to-a-day lag of a cached configuration.
     */
    const settings = (await this.configuration(request.temporalResolution, ctx, budget)).settings;
    const dates = request.temporalResolution === 'daily' || request.temporalResolution === 'hourly';
    const configured = (value: string | undefined) => value?.slice(0, dates ? 10 : 4);
    const product = { start: configured(settings?.start), end: configured(settings?.end) };
    const requested = dates
      ? { start: request.startDate, end: request.endDate }
      : 'startYear' in request && request.startYear !== undefined && request.endYear !== undefined
        ? { start: String(request.startYear), end: String(request.endYear) }
        : undefined;
    if (
      requested &&
      ((product.start && requested.start < product.start) ||
        (request.temporalResolution === 'climatology' &&
          product.end &&
          requested.end > product.end))
    ) {
      const local = this.localWindow(request.temporalResolution);
      throw windowError(
        request.temporalResolution,
        product.start ?? local.start,
        product.end ?? local.end,
      );
    }
    const dictionary = await this.dictionary(
      request.community,
      request.temporalResolution,
      ctx,
      budget,
    );
    const unsupported = codes.filter(
      (code) =>
        !(code in dictionary) &&
        !(code === TILTED_ALIAS && request.temporalResolution === 'climatology'),
    );
    if (unsupported.length)
      throw powerError(
        'unsupported_parameter',
        `Unsupported parameters: ${unsupported.join(', ')}`,
        { parameters: unsupported },
      );
    return codes;
  }
  private url(request: PowerRequest | RegionRequest, codes: string[]): URL {
    const url = new URL(
      `/api/temporal/${request.temporalResolution}/${'latitude' in request ? 'point' : 'regional'}`,
      origin,
    );
    const query = url.searchParams;
    for (const [key, value] of Object.entries({
      parameters: codes.join(','),
      community: request.community,
      format: 'JSON',
      units: request.units,
      'time-standard': request.timeStandard,
    }))
      query.set(key, value);
    if (request.temporalResolution === 'hourly' || request.temporalResolution === 'daily') {
      query.set('start', request.startDate.replaceAll('-', ''));
      query.set('end', request.endDate.replaceAll('-', ''));
    } else if (
      'startYear' in request &&
      request.startYear !== undefined &&
      request.endYear !== undefined
    ) {
      query.set('start', String(request.startYear));
      query.set('end', String(request.endYear));
    }
    if ('latitude' in request) {
      query.set('latitude', String(request.latitude));
      query.set('longitude', String(request.longitude));
      if (request.siteElevation !== undefined)
        query.set('site-elevation', String(request.siteElevation));
      if (request.windElevation !== undefined)
        query.set('wind-elevation', String(request.windElevation));
      if (request.windSurface !== undefined) query.set('wind-surface', request.windSurface);
    } else {
      query.set('latitude-min', String(request.latitudeMin));
      query.set('latitude-max', String(request.latitudeMax));
      query.set('longitude-min', String(request.longitudeMin));
      query.set('longitude-max', String(request.longitudeMax));
    }
    return url;
  }
  /** Retrieve a complete bounded point profile. Optional budget supports comparison orchestration. */
  async point(
    input: PowerRequest,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<PowerDataset> {
    const request = PowerRequestSchema.parse(input);
    if (request.windSurface === 'airport_ice' || request.windSurface === 'airport ice')
      request.windSurface = 'airportice';
    if (request.selection.mode === 'parameters')
      request.selection.parameters = [...new Set(request.selection.parameters)];
    const codes = await this.prepare(request, ctx, budget);
    const url = this.url(request, codes);
    const result = await this.load(url, PointPayloadSchema, ctx, budget, POWER_LIMITS.dataTtlMs);
    const dataset = normalizePoint(result.value, request, {
      endpointUrl: url.toString(),
      fetchedAt: result.fetchedAt,
      cacheHit: result.cacheHit,
      effectiveParameters: codes,
    });
    this.remaining(budget);
    return dataset;
  }
  /** Retrieve a complete bounded native-grid regional profile. */
  async region(
    input: RegionRequest,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<RegionalDataset> {
    if (
      input.temporalResolution === 'climatology' &&
      (Object.hasOwn(input, 'startYear') || Object.hasOwn(input, 'endYear'))
    )
      throw powerError(
        'invalid_window',
        'Regional climatology uses the precomputed source period and accepts no year fields.',
        {
          recovery: {
            hint: 'Omit startYear and endYear for the region, or use nasa_power_get_climatology for custom years at a point.',
          },
        },
      );
    const request = RegionRequestSchema.parse(input);
    const codes = await this.prepare(request, ctx, budget);
    const url = this.url(request, codes);
    const result = await this.load(url, RegionPayloadSchema, ctx, budget, POWER_LIMITS.dataTtlMs);
    const dataset = normalizeRegion(result.value, request, {
      endpointUrl: url.toString(),
      fetchedAt: result.fetchedAt,
      cacheHit: result.cacheHit,
    });
    this.remaining(budget);
    return dataset;
  }
  /**
   * Climatic design conditions at one point from POWER's Indicators API. Omitted years request the
   * configured coverage explicitly; a window the configuration refuses throws `invalid_window`
   * before any data request. `units` is never sent: POWER's imperial mode relabels metric values.
   */
  async designConditions(
    input: DesignConditionsRequest,
    ctx: Context,
    budget = this.createCallBudget(ctx),
  ): Promise<DesignConditions> {
    const request = DesignConditionsRequestSchema.parse(input);
    const configuration = await this.load(
      new URL('/api/application/indicators/configuration', origin),
      IndicatorsConfigurationSchema,
      ctx,
      budget,
      POWER_LIMITS.referenceTtlMs,
    );
    const years = resolveDesignYears(request, configuration.value);
    const url = new URL('/api/application/indicators/point', origin);
    url.search = new URLSearchParams({
      latitude: String(request.latitude),
      longitude: String(request.longitude),
      start: String(years.startYear),
      end: String(years.endYear),
      format: 'JSON',
    }).toString();
    const result = await this.load(
      url,
      DesignConditionsPayloadSchema,
      ctx,
      budget,
      POWER_LIMITS.dataTtlMs,
    );
    const conditions = normalizeDesignConditions(
      result.value,
      { latitude: request.latitude, longitude: request.longitude, ...years },
      {
        endpointUrl: url.toString(),
        fetchedAt: result.fetchedAt,
        cacheHit: result.cacheHit,
        ...result.headers,
      },
    );
    this.remaining(budget);
    return conditions;
  }
}
/** Factory for an injected service instance. */
export function createPowerService(options: PowerServiceOptions = {}): PowerService {
  return new PowerService(options);
}
let service: PowerService | undefined;
/** Initialize the process source service during createApp setup. */
export function initPowerService(options: PowerServiceOptions = {}): PowerService {
  service = createPowerService(options);
  return service;
}
/** Get the initialized source service. */
export function getPowerService(): PowerService {
  if (!service) throw new Error('PowerService not initialized; call initPowerService in setup.');
  return service;
}
