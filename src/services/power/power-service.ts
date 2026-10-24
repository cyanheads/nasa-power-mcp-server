/** @fileoverview Fixed-origin NASA POWER client with bounded shared pacing/cache. @module services/power/power-service */
import type { Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, defaultIsTransient, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, POWER_LIMITS, type ServerConfig } from '../../config/server-config.js';
import { describePowerError, powerError, REFERENCE_LIMIT_RECOVERY, shapeError } from './errors.js';
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

/** One producing operation owns this shared attempt/decoded-byte budget. */
export type PowerCallBudget = {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly maxBodyBytes: number;
  readonly comparison: boolean;
  attempts: number;
  decodedBytes: number;
};
/** Injection boundaries for offline fixtures and deterministic access timestamps. */
export type PowerServiceOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  config?: ServerConfig;
};
type Cached = { value: unknown; fetchedAt: string; expiresAt: number; bytes: number };
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
  /** Start before dictionaries/configuration, then pass the same object through all locations and canvas presentation. */
  createCallBudget(ctx: Context, comparison = false): PowerCallBudget {
    return {
      deadlineAt: this.now() + POWER_LIMITS.deadlineMs,
      signal: AbortSignal.any([
        ctx.signal,
        this.shutdown.signal,
        AbortSignal.timeout(POWER_LIMITS.deadlineMs),
      ]),
      maxAttempts: comparison ? POWER_LIMITS.comparisonAttempts : 6,
      maxBodyBytes: comparison ? POWER_LIMITS.comparisonBodyBytes : POWER_LIMITS.bodyBytes,
      comparison,
      attempts: 0,
      decodedBytes: 0,
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
  private store(key: string, value: unknown, fetchedAt: string, bytes: number, ttl: number): void {
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
      value: structuredClone(value),
      fetchedAt,
      expiresAt: this.now() + ttl,
      bytes,
    });
    this.cacheBytes += bytes;
  }
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
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  private async load<T>(
    url: URL,
    schema: z.ZodType<T>,
    ctx: Context,
    budget: PowerCallBudget,
    ttl: number,
  ): Promise<{ value: T; fetchedAt: string; cacheHit: boolean }> {
    this.remaining(budget);
    const key = url.toString();
    const hit = this.cached(key);
    if (hit)
      return { value: structuredClone(hit.value) as T, fetchedAt: hit.fetchedAt, cacheHit: true };
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
              this.remaining(budget);
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
                  throw powerError(
                    'upstream_rate_limited',
                    'NASA POWER rate limited this request.',
                    { ...data, retryAfter: response.headers.get('retry-after') ?? '2' },
                  );
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
              const value = parse(schema, raw);
              this.remaining(budget);
              const fetchedAt = new Date(this.now()).toISOString();
              this.store(key, value, fetchedAt, bytes, ttl);
              ctx.log.debug('NASA POWER response received', { bytes, cacheHit: false });
              return { value, fetchedAt, cacheHit: false };
            },
            { signal, maxWaitMs: Math.min(POWER_LIMITS.queueWaitMs, this.remaining(budget)) },
          );
        },
        {
          maxRetries: 1,
          baseDelayMs: 1_000,
          deadlineMs: this.remaining(budget),
          signal: budget.signal,
          operation: 'PowerService.load',
          context: ctx,
          isTransient: (error) =>
            !(error instanceof McpError && error.data?.reason === 'upstream_rate_limited') &&
            defaultIsTransient(error),
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
      if (error instanceof McpError && error.data?.operation !== undefined)
        throw new McpError(
          error.code,
          describePowerError(error.message, { operation: error.data.operation }),
          error.data,
          { cause: error },
        );
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
  private validateWindow(request: PowerRequest | RegionRequest): void {
    const current = new Date(this.now()).toISOString().slice(0, 10);
    const currentYear = Number(current.slice(0, 4));
    if (request.temporalResolution === 'daily' || request.temporalResolution === 'hourly') {
      const floor = request.temporalResolution === 'hourly' ? '2001-01-01' : '1981-01-01';
      if (
        request.startDate < floor ||
        request.endDate < request.startDate ||
        request.endDate > current
      )
        throw powerError(
          'invalid_window',
          `Use an ordered ${request.temporalResolution} window from ${floor} through ${current}.`,
        );
    } else if (request.temporalResolution === 'monthly' || 'latitude' in request) {
      if (
        (request.startYear === undefined) !== (request.endYear === undefined) ||
        (request.startYear !== undefined &&
          request.endYear !== undefined &&
          (request.startYear > request.endYear || request.endYear > currentYear))
      )
        throw powerError(
          'invalid_window',
          'Supply an ordered year pair within current source coverage.',
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
          'Regional requests do not support point corrections.',
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
    const configuration = await this.configuration(request.temporalResolution, ctx, budget);
    const start = configuration.settings?.start;
    const end = configuration.settings?.end;
    if (
      request.temporalResolution === 'climatology' &&
      'endYear' in request &&
      request.endYear !== undefined &&
      typeof end === 'string' &&
      request.endYear > Number(end.slice(0, 4))
    )
      throw powerError(
        'invalid_window',
        'Requested climatology extends beyond the configured product year window.',
      );
    if (typeof start === 'string') {
      const requestedStart =
        request.temporalResolution === 'daily' || request.temporalResolution === 'hourly'
          ? request.startDate
          : !('startYear' in request) || request.startYear === undefined
            ? undefined
            : `${request.startYear}-01-01`;
      if (requestedStart && requestedStart < start.slice(0, 10))
        throw powerError('invalid_window', 'Requested window begins before this product supports.');
    }
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
        'Regional climatology uses the precomputed source period. Omit startYear and endYear, or use nasa_power_get_climatology for custom years.',
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
