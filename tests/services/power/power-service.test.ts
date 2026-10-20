/** @fileoverview POWER service behavior at the HTTP boundary. @module tests/services/power/power-service */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { createPowerService, type PowerService } from '@/services/power/power-service.js';
import { PowerRequestSchema, RegionRequestSchema } from '@/services/power/types.js';

const daily = (extra = {}) =>
  PowerRequestSchema.parse(
    Object.fromEntries(
      Object.entries({
        temporalResolution: 'daily',
        latitude: 47,
        longitude: -122,
        startDate: '1982-01-01',
        endDate: '1982-01-02',
        selection: { mode: 'parameters', parameters: ['T2M'] },
        ...extra,
      }).filter(([, value]) => value !== undefined),
    ),
  );
const point = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-122, 47, 0] },
  properties: { parameter: { T2M: { '19820101': 0 } } },
};
const dictionary = { T2M: { inputs: null }, PSC: {}, WSC: {}, ALLSKY_SFC_SW_DWN: {} };
let services: PowerService[] = [];
const service = (fetcher: typeof fetch) => {
  const instance = createPowerService({
    fetch: fetcher,
    now: Date.now,
    config: { dataframeDropEnabled: false },
  });
  services.push(instance);
  return instance;
};
const respond = (url: Parameters<typeof fetch>[0]) => {
  const path = String(url);
  if (path.includes('/parameters?')) return Response.json(dictionary);
  if (path.endsWith('/configuration')) return Response.json({ settings: { start: '1981-01-01' } });
  return Response.json(point);
};

describe('PowerService HTTP contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  });
  afterEach(() => {
    for (const instance of services) instance.dispose();
    services = [];
    vi.useRealTimers();
  });
  it.each(['point', 'region'] as const)(
    'sends a NASA-valid optional user identifier for %s observations',
    async (geometry) => {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        const user = url.searchParams.get('user');
        if (user !== null && user.length >= 15)
          return Response.json(
            { messages: ['Please supply a correct user (shorter then 15 characters).'] },
            { status: 422 },
          );
        if (url.pathname.endsWith('/regional'))
          return Response.json({ type: 'FeatureCollection', features: [point] });
        return respond(input);
      });
      const instance = service(fetcher);
      const ctx = createMockContext();
      const pending = (
        geometry === 'point'
          ? instance.point(daily(), ctx)
          : instance.region(
              RegionRequestSchema.parse({
                temporalResolution: 'daily',
                latitudeMin: 0,
                latitudeMax: 2,
                longitudeMin: 0,
                longitudeMax: 2,
                parameter: 'T2M',
                startDate: '1982-01-01',
                endDate: '1982-01-02',
              }),
              ctx,
            )
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ rows: [{ T2M: 0 }] });
    },
  );
  it('serializes exact upstream URLs/options and correction aliases, caching immutable copies', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    const ctx = createMockContext();
    const input = daily({ siteElevation: 0, windElevation: 50, windSurface: 'airport_ice' });
    const resultPromise = instance.point(input, ctx);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://power.larc.nasa.gov/api/system/manager/parameters?community=RE&temporal=daily',
      'https://power.larc.nasa.gov/api/temporal/daily/configuration',
      'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M%2CPSC%2CWSC&community=RE&format=JSON&units=metric&time-standard=LST&start=19820101&end=19820102&latitude=47&longitude=-122&site-elevation=0&wind-elevation=50&wind-surface=airportice',
    ]);
    for (const call of fetcher.mock.calls)
      expect(call[1]).toMatchObject({
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      });
    result.rows[0]!.T2M = 999;
    const cached = await instance.point(input, ctx);
    expect(cached.rows[0]?.T2M).toBe(0);
    expect(cached.metadata).toMatchObject({ cacheHit: true, fetchedAt: result.metadata.fetchedAt });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['hourly', { startDate: '2024-01-01', endDate: '2024-01-02' }, 'start=20240101&end=20240102'],
    [
      'monthly',
      { startDate: undefined, endDate: undefined, startYear: 2024, endYear: 2024 },
      'start=2024&end=2024',
    ],
    ['climatology', { startDate: undefined, endDate: undefined }, null],
  ] as const)('uses %s source path and window encoding', async (resolution, window, query) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/point?'))
        return Response.json({ ...point, properties: { parameter: {} } });
      return respond(url);
    });
    const pending = service(fetcher).point(
      daily({ temporalResolution: resolution, ...window }),
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    const url = String(fetcher.mock.calls.at(-1)?.[0]);
    expect(url).toContain(`/api/temporal/${resolution}/point?`);
    if (query) expect(url).toContain(query);
    else expect(new URL(url).searchParams.has('start')).toBe(false);
  });
  it('uses regional endpoint and hyphenated bounds', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/regional?')
        ? Response.json({ type: 'FeatureCollection', features: [] })
        : respond(url),
    );
    const pending = service(fetcher).region(
      RegionRequestSchema.parse({
        temporalResolution: 'daily',
        latitudeMin: 0,
        latitudeMax: 2,
        longitudeMin: 1,
        longitudeMax: 3,
        parameter: 'T2M',
        startDate: '1982-01-01',
        endDate: '1982-01-01',
      }),
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).rows).toEqual([]);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('/regional?');
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(
      'latitude-min=0&latitude-max=2&longitude-min=1&longitude-max=3',
    );
  });
  it.each([
    [{ endDate: '1981-12-31' }, 'invalid_window'],
    [{ endDate: '2027-01-01' }, 'invalid_window'],
    [{ windElevation: 10 }, 'invalid_correction'],
    [{ selection: { mode: 'parameters', parameters: ['PSC'] } }, 'invalid_correction'],
    [
      {
        temporalResolution: 'hourly',
        startDate: '2024-01-01',
        endDate: '2024-01-01',
        selection: { mode: 'preset', preset: 'building_hvac' },
      },
      'unsupported_preset',
    ],
  ])('rejects invalid preparation before HTTP: %j', async (extra, reason) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(service(fetcher).point(daily(extra), createMockContext())).rejects.toMatchObject({
      data: { reason, recovery: { hint: expect.any(String) } },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains pre-1984 solar rejection messages without retry', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/point?')
        ? Response.json({ messages: ['Solar begins in 1984'] }, { status: 422 })
        : respond(url),
    );
    const outcome = service(fetcher)
      .point(
        daily({ selection: { mode: 'parameters', parameters: ['ALLSKY_SFC_SW_DWN'] } }),
        createMockContext(),
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await outcome).toMatchObject({
      data: { reason: 'upstream_rejected', messages: ['Solar begins in 1984'], retryable: false },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects climatology outside the configured product year window', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/configuration')
        ? Response.json({ settings: { start: '1984-01-01', end: '2025-12-31' } })
        : String(url).includes('/point?')
          ? Response.json({ ...point, properties: { parameter: {} } })
          : respond(url),
    );
    const pending = service(fetcher)
      .point(
        daily({
          temporalResolution: 'climatology',
          startDate: undefined,
          endDate: undefined,
          startYear: 2026,
          endYear: 2026,
        }),
        createMockContext(),
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ data: { reason: 'invalid_window' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires data after ten minutes while retaining reference caches', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    const ctx = createMockContext();
    const pending = instance.point(daily(), ctx);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    await vi.advanceTimersByTimeAsync(POWER_LIMITS.dataTtlMs);
    const refreshed = await instance.point(daily(), ctx);
    expect(refreshed.metadata.cacheHit).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('evicts least recently used entries at the 128-entry cache cap', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    const ctx = createMockContext();
    for (let index = 0; index < 127; index++) {
      const pending = instance.point(daily({ longitude: index }), ctx);
      await vi.advanceTimersByTimeAsync(4000);
      await pending;
    }
    const before = fetcher.mock.calls.length;
    const pending = instance.point(daily({ longitude: 0 }), ctx);
    await vi.advanceTimersByTimeAsync(6000);
    await pending;
    expect(fetcher.mock.calls.length - before).toBe(1);
  });
  it('limits each cold HTTP load to two attempts, including references, under 55 seconds', async () => {
    const counts = new Map<string, number>();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      const key = String(url);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count === 1 ? Response.json({}, { status: 503 }) : respond(url);
    });
    const instance = service(fetcher);
    const ctx = createMockContext();
    const budget = instance.createCallBudget(ctx);
    const start = Date.now();
    const pending = instance.point(daily(), ctx, budget);
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(budget.attempts).toBe(6);
    expect([...counts.values()]).toEqual([2, 2, 2]);
    expect(starts.every((stamp, i) => i === 0 || stamp - starts[i - 1]! >= 2000)).toBe(true);
    expect(starts.at(-1)! - start).toBeLessThan(55000);
  });
  it('shares twelve attempts across cold reference loads and multiple sites', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    const ctx = createMockContext();
    const budget = instance.createCallBudget(ctx, true);
    const start = Date.now();
    const pending = (async () => {
      for (let index = 0; index < 11; index++)
        await instance.point(daily({ latitude: index }), ctx, budget);
    })().catch((error) => error);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({
      message: expect.stringContaining('attempt budget exhausted'),
    });
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(budget.attempts).toBe(12);
    expect(Date.now() - start).toBeLessThan(55000);
  });
  it('does not retry malformed JSON or invalid scientific shapes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{'));
    const outcome = service(fetcher)
      .dictionary('RE', 'daily', createMockContext())
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ data: { retryable: false } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels a queued caller without starting its HTTP request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    await instance.dictionary('RE', 'daily', createMockContext());
    const controller = new AbortController();
    const pending = instance
      .configuration('daily', createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops a 429 call and applies its cooldown to the next caller', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return starts.length === 1
        ? Response.json(
            { messages: ['slow down'] },
            { status: 429, headers: { 'Retry-After': '5' } },
          )
        : respond(url);
    });
    const instance = service(fetcher);
    const ctx = createMockContext();
    const outcome = await instance.dictionary('RE', 'daily', ctx).catch((error) => error);
    expect(outcome).toMatchObject({ data: { reason: 'upstream_rate_limited', retryAfter: '5' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const pending = instance.dictionary('SB', 'daily', ctx);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(5000);
  });
  it('bounds decoded bodies regardless of Content-Length', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array(POWER_LIMITS.bodyBytes + 1), {
          headers: { 'Content-Length': '1' },
        }),
    );
    const outcome = service(fetcher)
      .dictionary('RE', 'daily', createMockContext())
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ data: { reason: 'dataset_limit' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses work beyond the shared overall deadline before HTTP starts', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
    const instance = service(fetcher);
    const ctx = createMockContext();
    const budget = instance.createCallBudget(ctx);
    vi.setSystemTime(Date.now() + POWER_LIMITS.deadlineMs);
    await expect(instance.dictionary('RE', 'daily', ctx, budget)).rejects.toMatchObject({
      message: expect.stringContaining('deadline exceeded'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sheds callers exceeding the bounded queue and settles pending work on disposal', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const instance = service(fetcher);
    const ctx = createMockContext();
    const calls = Array.from({ length: 34 }, () =>
      instance.dictionary('RE', 'daily', ctx).catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await calls.at(-1)).toMatchObject({ data: { reason: 'request_queue_full' } });
    instance.dispose();
    await Promise.all(calls);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
