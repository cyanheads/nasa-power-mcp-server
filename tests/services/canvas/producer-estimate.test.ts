/** @fileoverview Producer in-flight estimates: literal sizing, caps, and the upper bound over measured bytes. @module tests/services/canvas/producer-estimate */
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLocationsTool } from '@/mcp-server/tools/definitions/nasa-power-compare-locations.tool.js';
import { getClimatologyTool } from '@/mcp-server/tools/definitions/nasa-power-get-climatology.tool.js';
import { getRegionTool } from '@/mcp-server/tools/definitions/nasa-power-get-region.tool.js';
import { getTimeseriesTool } from '@/mcp-server/tools/definitions/nasa-power-get-timeseries.tool.js';
import { initCanvasService, type ProducerLease } from '@/services/canvas/index.js';
import {
  estimateComparisonBytes,
  estimatePointBytes,
  estimateRegionBytes,
  PRODUCER_CAP_BYTES,
} from '@/services/canvas/producer-estimate.js';
import { initPowerService } from '@/services/power/index.js';
import {
  CompareRequestSchema,
  PowerRequestSchema,
  RegionRequestSchema,
} from '@/services/power/types.js';
import { fakePower } from '../../fake-power.js';

const point = (extra: Record<string, unknown>) =>
  PowerRequestSchema.parse({
    latitude: 47.6,
    longitude: -122.3,
    selection: { mode: 'parameters', parameters: ['T2M'] },
    ...extra,
  });
const box = { latitudeMin: 40, latitudeMax: 42, longitudeMin: -122, longitudeMax: -120 };

describe('producer estimates from the request', () => {
  it('pins the exact in-flight caps per producer kind', () => {
    expect(PRODUCER_CAP_BYTES).toEqual({ single: 50_331_648, comparison: 67_108_864 });
  });

  it.each([
    ['daily, 31 days, one code', { startDate: '2024-01-01', endDate: '2024-01-31' }, 96_800],
    ['daily across a leap day', { startDate: '2024-02-28', endDate: '2024-03-01' }, 83_360],
    [
      'daily with siteElevation adding PSC',
      { startDate: '2024-01-01', endDate: '2024-01-31', siteElevation: 50 },
      99_776,
    ],
    [
      'hourly, one day',
      { temporalResolution: 'hourly', startDate: '2024-01-01', endDate: '2024-01-01' },
      77_056,
    ],
    [
      'monthly, one year',
      { temporalResolution: 'monthly', startYear: 2019, endYear: 2019 },
      612_448,
    ],
    [
      'monthly, five years, two codes',
      {
        temporalResolution: 'monthly',
        startYear: 2015,
        endYear: 2019,
        selection: { mode: 'parameters', parameters: ['T2M', 'RH2M'] },
      },
      643_648,
    ],
    ['climatology, one code', { temporalResolution: 'climatology' }, 743_520],
    [
      'climatology with an alias group counted at the 64-column cap',
      {
        temporalResolution: 'climatology',
        selection: { mode: 'parameters', parameters: ['SI_TILTED_AVG', 'T2M'] },
      },
      822_144,
    ],
    [
      'climatology with an hour group counted at the 64-column cap',
      {
        temporalResolution: 'climatology',
        selection: { mode: 'parameters', parameters: ['ALLSKY_SFC_SW_DWN_HR', 'T2M'] },
      },
      822_144,
    ],
  ])('sizes a point %s', (_shape, extra, bytes) => {
    expect(estimatePointBytes(point(extra))).toBe(bytes);
  });

  it('caps a point estimate at the single-producer worst case', () => {
    const worst = point({
      temporalResolution: 'hourly',
      startDate: '2001-01-01',
      endDate: '2026-10-18',
      selection: { mode: 'parameters', parameters: Array.from({ length: 15 }, (_, i) => `P${i}`) },
    });
    expect(estimatePointBytes(worst)).toBe(PRODUCER_CAP_BYTES.single);
  });

  it.each([
    /** 5 latitudes × 4 longitudes: POWER returns 20 cells for this box. */
    ['an on-grid daily box', { ...box, startDate: '2024-01-01', endDate: '2024-01-31' }, 384_640],
    ['an on-grid climatology box', { ...box, temporalResolution: 'climatology' }, 867_200],
    /** 260 rows, each with up to 64 member values instead of one. */
    [
      'an on-grid climatology box of an hour group',
      { ...box, temporalResolution: 'climatology', parameter: 'ALLSKY_SFC_SW_DWN_HR_MAX' },
      2_439_680,
    ],
    /** The same span shifted off the grid holds 16 cells; the bound still counts 20. */
    [
      'an off-grid daily box',
      {
        latitudeMin: 40.2,
        latitudeMax: 42.2,
        longitudeMin: -121.9,
        longitudeMax: -119.9,
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      },
      384_640,
    ],
  ])('sizes a region over %s from its native cell count', (_shape, extra, bytes) => {
    expect(estimateRegionBytes(RegionRequestSchema.parse({ parameter: 'T2M', ...extra }))).toBe(
      bytes,
    );
  });

  it('sizes a comparison per site response and per row identity', () => {
    const request = CompareRequestSchema.parse({
      temporalResolution: 'daily',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      locations: ['a', 'b', 'c'].map((label, i) => ({ latitude: 40 + i, longitude: -120, label })),
      selection: { mode: 'parameters', parameters: ['T2M'] },
    });
    /** Each site's `{"locationId":"location_n","label":"x"}` is 39 bytes on all 31 days. */
    expect(estimateComparisonBytes(request)).toBe(162_955);
  });

  it('caps a comparison at the comparison worst case', () => {
    const request = CompareRequestSchema.parse({
      temporalResolution: 'hourly',
      startDate: '2001-01-01',
      endDate: '2026-10-18',
      locations: [
        { latitude: 1, longitude: 1, label: 'a' },
        { latitude: 2, longitude: 2, label: 'b' },
      ],
      selection: { mode: 'parameters', parameters: Array.from({ length: 15 }, (_, i) => `P${i}`) },
    });
    expect(estimateComparisonBytes(request)).toBe(PRODUCER_CAP_BYTES.comparison);
  });
});

describe('estimate against the bytes a cold call measures', () => {
  /** Dictionary bodies measured from POWER, plus the ~317-byte configuration body. */
  const dictionaryBytes = {
    hourly: 32_317,
    daily: 46_317,
    monthly: 449_317,
    climatology: 561_317,
  };
  let source: ReturnType<typeof initPowerService>;
  let canvas: ReturnType<typeof initCanvasService>;
  let calls: { estimate: number; measured: number }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    source = initPowerService({
      fetch: fakePower(['T2M', 'SI_TILTED_AVG'], { dictionaryBytes }).fetch,
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    canvas = initCanvasService({
      storage: createInMemoryStorage(),
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    calls = [];
    const admit = canvas.withProducer.bind(canvas);
    /** Record the estimate and the largest decoded-body plus row total the lease is told. */
    vi.spyOn(canvas, 'withProducer').mockImplementation((estimate, ctx, run) => {
      const call = { estimate, measured: 0 };
      calls.push(call);
      const seen = { body: 0, rows: 0 };
      const note = () => {
        call.measured = Math.max(call.measured, seen.body + seen.rows);
      };
      return admit(estimate, ctx, (scoped, lease) =>
        run(scoped, {
          remainingMs: lease.remainingMs,
          bodyBytes: (total) => {
            seen.body = total;
            note();
            lease.bodyBytes(total);
          },
          rowBytes: (total) => {
            seen.rows = total;
            note();
            lease.rowBytes(total);
          },
        } satisfies ProducerLease),
      );
    });
  });
  afterEach(async () => {
    source.dispose();
    await canvas.shutdown();
    vi.useRealTimers();
  });

  const year = { startDate: '2024-01-01', endDate: '2024-12-31' };
  const site = { latitude: 47.6, longitude: -122.3 };
  const T2M = { mode: 'parameters', parameters: ['T2M'] };
  it.each([
    ['a daily-year time series', getTimeseriesTool, { ...site, ...year, selection: T2M }],
    [
      'an hourly-month time series',
      getTimeseriesTool,
      {
        ...site,
        temporalResolution: 'hourly',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        selection: T2M,
      },
    ],
    [
      'a 35-year monthly time series',
      getTimeseriesTool,
      { ...site, temporalResolution: 'monthly', startYear: 1990, endYear: 2024, selection: T2M },
    ],
    ['a one-code climatology', getClimatologyTool, { ...site, selection: T2M }],
    [
      'a climatology with an alias group',
      getClimatologyTool,
      { ...site, selection: { mode: 'parameters', parameters: ['SI_TILTED_AVG', 'T2M'] } },
    ],
    [
      'a daily-month region',
      getRegionTool,
      {
        latitudeMin: 46,
        latitudeMax: 48,
        longitudeMin: -123,
        longitudeMax: -121,
        parameter: 'T2M',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      },
    ],
    [
      'a four-site daily-year comparison',
      compareLocationsTool,
      {
        temporalResolution: 'daily',
        ...year,
        locations: [0, 1, 2, 3].map((i) => ({
          latitude: 40 + i,
          longitude: -120 - i,
          label: `site ${i}`,
        })),
        selection: T2M,
      },
    ],
  ] as const)('bounds %s from above', async (_shape, tool, args) => {
    const pending = runToolContract(
      tool as Parameters<typeof runToolContract>[0],
      args as Parameters<typeof runToolContract>[1],
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(calls).toHaveLength(1);
    const [call] = calls;
    /** A cold call reads at least the dictionary body before any observation. */
    expect(call?.measured).toBeGreaterThan(32_317);
    expect(call?.estimate).toBeGreaterThanOrEqual(call?.measured ?? Number.POSITIVE_INFINITY);
  });
});
