/** @fileoverview POWER service behavior at the HTTP boundary. @module tests/services/power/power-service */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { createPowerService, type PowerService } from '@/services/power/power-service.js';
import { PowerRequestSchema, RegionRequestSchema } from '@/services/power/types.js';
import { streamedBody } from '../../fake-power.js';

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
    config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
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
  it.each(['point', 'region'] as const)(
    'preserves custom %s year windows on supported products',
    async (geometry) => {
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes('/regional?'))
          return Response.json({ type: 'FeatureCollection', features: [] });
        if (String(url).includes('/point?'))
          return Response.json({ ...point, properties: { parameter: {} } });
        return respond(url);
      });
      const instance = service(fetcher);
      const pending =
        geometry === 'point'
          ? instance.point(
              daily({
                temporalResolution: 'climatology',
                startDate: undefined,
                endDate: undefined,
                startYear: 1991,
                endYear: 2020,
              }),
              createMockContext(),
            )
          : instance.region(
              RegionRequestSchema.parse({
                temporalResolution: 'monthly',
                latitudeMin: 0,
                latitudeMax: 2,
                longitudeMin: 0,
                longitudeMax: 2,
                parameter: 'T2M',
                startYear: 1991,
                endYear: 2020,
              }),
              createMockContext(),
            );
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]));
      expect(url.searchParams.get('start')).toBe('1991');
      expect(url.searchParams.get('end')).toBe('2020');
      expect(result.request).toMatchObject({ startYear: 1991, endYear: 2020 });
    },
  );
  it.each([{ startYear: 1991 }, { endYear: 2020 }, { startYear: 1991, endYear: 2020 }])(
    'rejects raw regional climatology year fields before references: %j',
    async (years) => {
      const fetcher = vi.fn<typeof fetch>(async (url) => respond(url));
      const input = {
        ...RegionRequestSchema.parse({
          temporalResolution: 'climatology',
          latitudeMin: 0,
          latitudeMax: 2,
          longitudeMin: 0,
          longitudeMax: 2,
          parameter: 'T2M',
        }),
        ...years,
      };
      await expect(service(fetcher).region(input, createMockContext())).rejects.toMatchObject({
        data: { reason: 'invalid_window' },
        message: expect.stringContaining('nasa_power_get_climatology'),
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
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
  describe('held body bytes across a retried load', () => {
    const MiB = 1024 * 1024;
    /** Cold dictionary and configuration bodies the call holds before its data body. */
    const referenceBytes =
      JSON.stringify(dictionary).length +
      JSON.stringify({ settings: { start: '1981-01-01' } }).length;
    /** The point payload padded with trailing whitespace to `bytes`. */
    const padded = (bytes: number) => {
      const json = JSON.stringify(point);
      return new Response(json + ' '.repeat(bytes - json.length));
    };
    /** Every held-byte total one cold point call reports, its data load optionally failing once. */
    async function reported(failFirst?: () => Response) {
      let failed = !failFirst;
      const totals: number[] = [];
      const instance = service(
        vi.fn<typeof fetch>(async (url) => {
          if (!String(url).includes('/point?')) return respond(url);
          if (failed) return padded(8 * MiB);
          failed = true;
          return failFirst!();
        }),
      );
      const ctx = createMockContext();
      const budget = instance.createCallBudget(ctx, false, {
        onHeldBytes: (total) => totals.push(total),
      });
      const pending = instance.point(daily(), ctx, budget);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      return totals;
    }
    it.each([
      ['fails partway through its body', () => streamedBody(6 * MiB, 'error')],
      ['answers 503 with a whole body', () => streamedBody(6 * MiB, { status: 503 })],
    ])('releases the body of an attempt that %s before the retry counts', async (_shape, fail) => {
      const once = await reported();
      const retried = await reported(fail);
      /** The failed body was counted while it was held… */
      expect(retried).toContain(referenceBytes + 6 * MiB);
      /** …and left the count, so the retried call peaks and ends where a first-time success does. */
      expect(Math.max(...retried)).toBe(Math.max(...once));
      expect(retried.at(-1)).toBe(referenceBytes + 8 * MiB);
      expect(once.at(-1)).toBe(referenceBytes + 8 * MiB);
    });
    it("counts every attempt's body, discarded ones included, against the comparison ceiling", async () => {
      let data = 0;
      const instance = service(
        vi.fn<typeof fetch>(async (url) => {
          if (!String(url).includes('/point?')) return respond(url);
          data++;
          return data === 1 ? streamedBody(15 * MiB, 'error') : padded((data === 2 ? 15 : 3) * MiB);
        }),
      );
      const ctx = createMockContext();
      const budget = instance.createCallBudget(ctx, true);
      const first = instance.point(daily({ latitude: 1 }), ctx, budget);
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      const second = instance.point(daily({ latitude: 2 }), ctx, budget).catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      /** 15 + 15 + 3 MiB decoded passes the 32 MiB ceiling though only 18 MiB is held. */
      expect(await second).toMatchObject({ data: { reason: 'dataset_limit' } });
      expect(data).toBe(3);
    });
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

describe('codes POWER lists but does not serve at a resolution', () => {
  /** The dictionary codes that answered HTTP 500 at each resolution in AG, RE and SB (2026-10-28 sweep). */
  const unserved = {
    monthly: [
      'GDD4_4',
      'GDD7_2',
      'GDD10',
      'GDD13_3',
      'GDD15_6',
      'ALLSKY_SFC_SW_DIFF_HR_MAX',
      'ALLSKY_SFC_SW_DIFF_HR_MIN',
      'ALLSKY_SFC_SW_DNI_HR_MAX',
      'ALLSKY_SFC_SW_DNI_HR_MIN',
      'ALLSKY_SFC_SW_DWN_HR_MAX',
      'ALLSKY_SFC_SW_DWN_HR_MIN',
    ],
    climatology: ['GDD4_4', 'GDD7_2', 'GDD10', 'GDD13_3', 'GDD15_6'],
  };
  const listed = [
    ...new Set([
      ...unserved.monthly,
      'T2M',
      'HDD18_3',
      'CDD18_3',
      'ALLSKY_SFC_SW_DWN_HR',
      'SI_TRACKER_AVG',
    ]),
  ];
  /** POWER's dictionary lists every code at every non-hourly resolution; its data endpoints answer 500. */
  const listing = vi.fn<typeof fetch>(async (url) => {
    const path = String(url);
    if (path.includes('/parameters?'))
      return Response.json(Object.fromEntries(listed.map((code) => [code, {}])));
    if (path.endsWith('/configuration')) return Response.json({});
    return Response.json({ header: 'Server Side Error' }, { status: 500 });
  });
  const windows = {
    daily: { startDate: '2023-06-01', endDate: '2023-06-03' },
    monthly: { startDate: undefined, endDate: undefined, startYear: 2023, endYear: 2023 },
    climatology: { startDate: undefined, endDate: undefined },
  } as const;
  const at = (resolution: keyof typeof windows, parameters: string[]) =>
    daily({
      temporalResolution: resolution,
      ...windows[resolution],
      selection: { mode: 'parameters', parameters },
    });
  const regionAt = (resolution: 'daily' | 'monthly' | 'climatology', parameter: string) =>
    RegionRequestSchema.parse({
      temporalResolution: resolution,
      latitudeMin: 40,
      latitudeMax: 42,
      longitudeMin: -95,
      longitudeMax: -93,
      parameter,
      ...(resolution === 'daily'
        ? windows.daily
        : resolution === 'monthly'
          ? { startYear: 2023, endYear: 2023 }
          : {}),
    });
  /** A climatology has no dates, so the GDD recovery names the window it can request at daily. */
  const familyHint = (code: string) =>
    code.startsWith('GDD')
      ? 'Growing degree day codes (GDD4_4, GDD7_2, GDD10, GDD13_3, GDD15_6) are served only at daily resolution: request the window at daily (for a climatology, its start and end years) and sum the daily values for each month, season or year, averaging those sums across years for a climatological value.'
      : expect.stringMatching(/_HR_MAX.*climatology/);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    listing.mockClear();
  });
  afterEach(() => {
    for (const instance of services) instance.dispose();
    services = [];
    vi.useRealTimers();
  });

  it.each(
    Object.entries(unserved).flatMap(([resolution, codes]) =>
      codes.map((code) => [resolution as 'monthly' | 'climatology', code] as const),
    ),
  )('rejects %s %s with its family recovery before any request', async (resolution, code) => {
    const outcome = service(listing)
      .point(at(resolution, [code]), createMockContext())
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({
      data: {
        reason: 'unsupported_parameter',
        parameters: [code],
        recovery: { hint: familyHint(code) },
      },
      message: expect.stringContaining(code),
    });
    expect(listing).not.toHaveBeenCalled();
  });

  it('names only the unserved codes of a mixed selection and joins both family recoveries', async () => {
    const pending = service(listing)
      .point(
        at('monthly', ['T2M', 'GDD10', 'ALLSKY_SFC_SW_DWN_HR_MAX', 'HDD18_3']),
        createMockContext(),
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      data: {
        reason: 'unsupported_parameter',
        parameters: ['GDD10', 'ALLSKY_SFC_SW_DWN_HR_MAX'],
        recovery: {
          hint: expect.stringMatching(/Growing degree day.*daily.*_HR_MAX.*climatology/s),
        },
      },
    });
    expect(outcome.message).not.toContain('T2M');
    expect(listing).not.toHaveBeenCalled();
  });

  it.each(['monthly', 'climatology'] as const)(
    'rejects a %s region of GDD10 before any request',
    async (resolution) => {
      const outcome = service(listing)
        .region(regionAt(resolution, 'GDD10'), createMockContext())
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toMatchObject({
        data: {
          reason: 'unsupported_parameter',
          parameters: ['GDD10'],
          recovery: { hint: familyHint('GDD10') },
        },
      });
      expect(listing).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['daily', ['GDD4_4', 'GDD7_2', 'GDD10', 'GDD13_3', 'GDD15_6']],
    ['climatology', ['ALLSKY_SFC_SW_DWN_HR_MAX', 'ALLSKY_SFC_SW_DIFF_HR_MIN', 'SI_TRACKER_AVG']],
    ['monthly', ['ALLSKY_SFC_SW_DWN_HR', 'T2M']],
    ...(['daily', 'monthly', 'climatology'] as const).map(
      (resolution) => [resolution, ['HDD18_3', 'CDD18_3']] as const,
    ),
  ] as const)(
    'still validates served %s codes %j against the dictionary',
    async (resolution, codes) => {
      const instance = service(listing);
      const pending = instance.validateRequest(at(resolution, [...codes]), createMockContext());
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toBeUndefined();
      expect(listing.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/api/system/manager/parameters',
        `/api/temporal/${resolution}/configuration`,
      ]);
    },
  );

  it('still validates a daily region of GDD10', async () => {
    const pending = service(listing).validateRequest(
      regionAt('daily', 'GDD10'),
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
  });
});
