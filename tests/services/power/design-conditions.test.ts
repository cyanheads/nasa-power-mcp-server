/** @fileoverview POWER Indicators design conditions through the real load, cache and normalizer seams. @module tests/services/power/design-conditions */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERIES } from '@/services/power/errors.js';
import { createPowerService, type PowerService } from '@/services/power/power-service.js';
import { type DesignConditionsRequest, DesignConditionsSchema } from '@/services/power/types.js';
import { fakePower, fixture, monthValues } from '../../fake-power.js';

type Payload = Record<string, unknown> & { metadata: Record<string, unknown> };
const seattle = await fixture<Payload>('design-conditions-seattle-2020-2024.json');
/** The full configured coverage, as an omitted-years call requests it; POWER fills its timezone. */
const seattleCoverage = await fixture<Payload>('design-conditions-seattle-2001-2025.json');
const sparse = await fixture<Payload>('design-conditions-sparse.json');
const configuration = await fixture<Payload>('design-conditions-configuration.json');
const spanRejected = await fixture<Payload>('design-conditions-span-rejected.json');

const CONFIGURATION_URL = 'https://power.larc.nasa.gov/api/application/indicators/configuration';
const POINT_PATH = '/api/application/indicators/point';
const SEATTLE = { latitude: 47.61, longitude: -122.33 };
const WINDOW = { startYear: 2020, endYear: 2024 };
const COVERAGE = 'Design-condition years must fall within 2001 to 2025 and span at least 5 years.';

type Described = [code: string, label: string, units: string];
/**
 * The Seattle fixture's scalars as labeled, by report section, each section in the order of POWER's
 * Climatic Design Conditions report for that point (`format=HTML`). The monthly section's annual
 * scalars follow the extreme-annual ones; metric units are the ones its `metadata.units` reports.
 */
const REPORT_SCALARS: Record<string, Described[]> = {
  heating_humidification: [
    ['CD_CM', 'Coldest month', 'month (1-12)'],
    ['CD_DB_996', 'Heating dry-bulb, 99.6%', 'C'],
    ['CD_DB_990', 'Heating dry-bulb, 99%', 'C'],
    ['CD_DP_996', 'Humidification dew point, 99.6%', 'C'],
    ['CD_MCHR_996', 'Humidity ratio at the 99.6% humidification dew point', 'g/kg'],
    ['CD_MCDB_996', 'Mean coincident dry-bulb at the 99.6% humidification dew point', 'C'],
    ['CD_DP_990', 'Humidification dew point, 99%', 'C'],
    ['CD_MCHR_990', 'Humidity ratio at the 99% humidification dew point', 'g/kg'],
    ['CD_MCDB_990', 'Mean coincident dry-bulb at the 99% humidification dew point', 'C'],
    ['CD_WS_CM_004', 'Coldest-month wind speed, 0.4%', 'm/s'],
    ['CD_MCDB_CM_004', 'Mean coincident dry-bulb at the 0.4% coldest-month wind speed', 'C'],
    ['CD_WS_CM_010', 'Coldest-month wind speed, 1%', 'm/s'],
    ['CD_MCDB_CM_010', 'Mean coincident dry-bulb at the 1% coldest-month wind speed', 'C'],
    ['CD_MCWS_996', 'Mean coincident wind speed to the 99.6% heating dry-bulb', 'm/s'],
    [
      'CD_MCWD_996',
      'Prevailing coincident wind direction to the 99.6% heating dry-bulb',
      'degrees',
    ],
  ],
  cooling_dehumidification_enthalpy: [
    ['CD_WM', 'Hottest month', 'month (1-12)'],
    ['CD_DB_RANGE', 'Hottest-month mean daily dry-bulb range', 'C'],
    ['CD_DB_004', 'Cooling dry-bulb, 0.4%', 'C'],
    ['CD_MCWB_004', 'Mean coincident wet-bulb at the 0.4% cooling dry-bulb', 'C'],
    ['CD_DB_010', 'Cooling dry-bulb, 1%', 'C'],
    ['CD_MCWB_010', 'Mean coincident wet-bulb at the 1% cooling dry-bulb', 'C'],
    ['CD_DB_020', 'Cooling dry-bulb, 2%', 'C'],
    ['CD_MCWB_020', 'Mean coincident wet-bulb at the 2% cooling dry-bulb', 'C'],
    ['CD_WB_004', 'Evaporation wet-bulb, 0.4%', 'C'],
    ['CD_MCDB_WB_004', 'Mean coincident dry-bulb at the 0.4% evaporation wet-bulb', 'C'],
    ['CD_WB_010', 'Evaporation wet-bulb, 1%', 'C'],
    ['CD_MCDB_WB_010', 'Mean coincident dry-bulb at the 1% evaporation wet-bulb', 'C'],
    ['CD_WB_020', 'Evaporation wet-bulb, 2%', 'C'],
    ['CD_MCDB_WB_020', 'Mean coincident dry-bulb at the 2% evaporation wet-bulb', 'C'],
    ['CD_MCWS_DB_004', 'Mean coincident wind speed to the 0.4% cooling dry-bulb', 'm/s'],
    [
      'CD_MCWD_DB_004',
      'Prevailing coincident wind direction to the 0.4% cooling dry-bulb',
      'degrees',
    ],
    ['CD_DP_004', 'Dehumidification dew point, 0.4%', 'C'],
    ['CD_MCHR_DP_004', 'Humidity ratio at the 0.4% dehumidification dew point', 'g/kg'],
    ['CD_MCDB_DP_004', 'Mean coincident dry-bulb at the 0.4% dehumidification dew point', 'C'],
    ['CD_DP_010', 'Dehumidification dew point, 1%', 'C'],
    ['CD_MCHR_DP_010', 'Humidity ratio at the 1% dehumidification dew point', 'g/kg'],
    ['CD_MCDB_DP_010', 'Mean coincident dry-bulb at the 1% dehumidification dew point', 'C'],
    ['CD_DP_020', 'Dehumidification dew point, 2%', 'C'],
    ['CD_MCHR_DP_020', 'Humidity ratio at the 2% dehumidification dew point', 'g/kg'],
    ['CD_MCDB_DP_020', 'Mean coincident dry-bulb at the 2% dehumidification dew point', 'C'],
    ['CD_EN_004', 'Enthalpy, 0.4%', 'kJ/kg'],
    ['CD_MCDB_EN_004', 'Mean coincident dry-bulb at the 0.4% enthalpy', 'C'],
    ['CD_EN_010', 'Enthalpy, 1%', 'kJ/kg'],
    ['CD_MCDB_EN_010', 'Mean coincident dry-bulb at the 1% enthalpy', 'C'],
    ['CD_EN_020', 'Enthalpy, 2%', 'kJ/kg'],
    ['CD_MCDB_EN_020', 'Mean coincident dry-bulb at the 2% enthalpy', 'C'],
    ['CD_T2MWET_MAX_VALUE', 'Extreme maximum wet-bulb', 'C'],
  ],
  extreme_annual: [
    ['CD_EXT_WS_010', 'Extreme annual wind speed, 1%', 'm/s'],
    ['CD_EXT_WS_025', 'Extreme annual wind speed, 2.5%', 'm/s'],
    ['CD_EXT_WS_050', 'Extreme annual wind speed, 5%', 'm/s'],
    ['CD_DB_MIN_AVG', 'Extreme annual minimum dry-bulb, mean', 'C'],
    ['CD_DB_MAX_AVG', 'Extreme annual maximum dry-bulb, mean', 'C'],
    ['CD_DB_MIN_STD', 'Extreme annual minimum dry-bulb, standard deviation', 'C'],
    ['CD_DB_MAX_STD', 'Extreme annual maximum dry-bulb, standard deviation', 'C'],
    ['CD_DB_EXTREME_MIN_05', '5-year return period minimum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MAX_05', '5-year return period maximum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MIN_10', '10-year return period minimum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MAX_10', '10-year return period maximum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MIN_20', '20-year return period minimum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MAX_20', '20-year return period maximum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MIN_50', '50-year return period minimum dry-bulb', 'C'],
    ['CD_DB_EXTREME_MAX_50', '50-year return period maximum dry-bulb', 'C'],
    ['CD_WB_MIN_AVG', 'Extreme annual minimum wet-bulb, mean', 'C'],
    ['CD_WB_MAX_AVG', 'Extreme annual maximum wet-bulb, mean', 'C'],
    ['CD_WB_MIN_STD', 'Extreme annual minimum wet-bulb, standard deviation', 'C'],
    ['CD_WB_MAX_STD', 'Extreme annual maximum wet-bulb, standard deviation', 'C'],
    ['CD_WB_EXTREME_MIN_05', '5-year return period minimum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MAX_05', '5-year return period maximum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MIN_10', '10-year return period minimum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MAX_10', '10-year return period maximum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MIN_20', '20-year return period minimum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MAX_20', '20-year return period maximum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MIN_50', '50-year return period minimum wet-bulb', 'C'],
    ['CD_WB_EXTREME_MAX_50', '50-year return period maximum wet-bulb', 'C'],
  ],
  monthly: [
    ['CD_DB_AVG', 'Annual mean of daily (max+min)/2 dry-bulb', 'C'],
    ['CD_DB_STD', 'Standard deviation of daily (max+min)/2 dry-bulb over the year', 'C'],
    ['CD_HDD10_SUM', 'Annual heating degree-days, base 10.0 °C', 'degree-day-c'],
    ['CD_HDD18_SUM', 'Annual heating degree-days, base 18.3 °C', 'degree-day-c'],
    ['CD_CDD10_SUM', 'Annual cooling degree-days, base 10.0 °C', 'degree-day-c'],
    ['CD_CDD18_SUM', 'Annual cooling degree-days, base 18.3 °C', 'degree-day-c'],
    ['CD_CDH23_SUM', 'Annual cooling degree-hours, base 23.3 °C', 'degree-hour-c'],
    ['CD_CDH26_SUM', 'Annual cooling degree-hours, base 26.7 °C', 'degree-hour-c'],
    ['CD_WS10M_ANNUAL', 'Annual mean 10 m wind speed', 'm/s'],
    ['CD_PRECTOTCORR_SUM', 'Annual mean precipitation total', 'mm'],
    ['CD_PRECTOTCORR_ANNUAL_MAX', 'Largest annual precipitation total', 'mm'],
    ['CD_PRECTOTCORR_ANNUAL_MIN', 'Smallest annual precipitation total', 'mm'],
    ['CD_PRECTOTCORR_ANNUAL_STD', 'Standard deviation of annual precipitation totals', 'mm'],
  ],
};
/** The fixture's twelve-month rows, all in the report's monthly section, in report order. */
const REPORT_MONTHS: Described[] = [
  ['CD_T2M_AVG', 'Monthly mean of daily (max+min)/2 dry-bulb', 'C'],
  ['CD_T2M_STD', 'Standard deviation of daily (max+min)/2 dry-bulb within each month', 'C'],
  ['CD_HDD10', 'Monthly heating degree-days, base 10.0 °C', 'degree-day-c'],
  ['CD_HDD18', 'Monthly heating degree-days, base 18.3 °C', 'degree-day-c'],
  ['CD_CDD10', 'Monthly cooling degree-days, base 10.0 °C', 'degree-day-c'],
  ['CD_CDD18', 'Monthly cooling degree-days, base 18.3 °C', 'degree-day-c'],
  ['CD_CDH23', 'Monthly cooling degree-hours, base 23.3 °C', 'degree-hour-c'],
  ['CD_CDH26', 'Monthly cooling degree-hours, base 26.7 °C', 'degree-hour-c'],
  ['CD_WS10M_MONTH', 'Monthly mean 10 m wind speed', 'm/s'],
  ['CD_PRECTOTCORR', 'Monthly mean precipitation total', 'mm'],
  ['CD_PRECTOTCORR_MONTH_MAX', 'Largest monthly precipitation total', 'mm'],
  ['CD_PRECTOTCORR_MONTH_MIN', 'Smallest monthly precipitation total', 'mm'],
  ['CD_PRECTOTCORR_MONTH_STD', 'Standard deviation of monthly precipitation totals', 'mm'],
  ['CD_DB_TEMP_004', 'Monthly design dry-bulb, 0.4%', 'C'],
  ['CD_MCWB_TEMP_004', 'Mean coincident wet-bulb at the monthly 0.4% design dry-bulb', 'C'],
  ['CD_DB_TEMP_020', 'Monthly design dry-bulb, 2%', 'C'],
  ['CD_MCWB_TEMP_020', 'Mean coincident wet-bulb at the monthly 2% design dry-bulb', 'C'],
  ['CD_DB_TEMP_050', 'Monthly design dry-bulb, 5%', 'C'],
  ['CD_MCWB_TEMP_050', 'Mean coincident wet-bulb at the monthly 5% design dry-bulb', 'C'],
  ['CD_DB_TEMP_100', 'Monthly design dry-bulb, 10%', 'C'],
  ['CD_MCWB_TEMP_100', 'Mean coincident wet-bulb at the monthly 10% design dry-bulb', 'C'],
  ['CD_WB_TEMP_004', 'Monthly design wet-bulb, 0.4%', 'C'],
  ['CD_MCDB_TEMP_004', 'Mean coincident dry-bulb at the monthly 0.4% design wet-bulb', 'C'],
  ['CD_WB_TEMP_020', 'Monthly design wet-bulb, 2%', 'C'],
  ['CD_MCDB_TEMP_020', 'Mean coincident dry-bulb at the monthly 2% design wet-bulb', 'C'],
  ['CD_WB_TEMP_050', 'Monthly design wet-bulb, 5%', 'C'],
  ['CD_MCDB_TEMP_050', 'Mean coincident dry-bulb at the monthly 5% design wet-bulb', 'C'],
  ['CD_WB_TEMP_100', 'Monthly design wet-bulb, 10%', 'C'],
  ['CD_MCDB_TEMP_100', 'Mean coincident dry-bulb at the monthly 10% design wet-bulb', 'C'],
  ['CD_DB_RANGE_MONTH', 'Mean daily dry-bulb range', 'C'],
  ['CD_MCDBR_DB', 'Mean coincident dry-bulb range at the monthly 5% design dry-bulb', 'C'],
  ['CD_MCWBR_DB', 'Mean coincident wet-bulb range at the monthly 5% design dry-bulb', 'C'],
  ['CD_MCDBR_WB', 'Mean coincident dry-bulb range at the monthly 5% design wet-bulb', 'C'],
  ['CD_MCWBR_WB', 'Mean coincident wet-bulb range at the monthly 5% design wet-bulb', 'C'],
  ['CD_CLRSKY_SFC_SW_DNI_NOON_HOUR', 'Clear-sky beam normal irradiance at noon', 'W/m^2'],
  ['CD_CLRSKY_SFC_SW_DIFF_NOON_HOUR', 'Clear-sky diffuse horizontal irradiance at noon', 'W/m^2'],
  ['CD_RADIATION_AVG', 'Mean daily all-sky surface solar radiation', 'kW-hr/m^2/day'],
  [
    'CD_RADIATION_STD',
    'Standard deviation of daily all-sky surface solar radiation',
    'kW-hr/m^2/day',
  ],
];
/** A row's description, its value left out. */
const described = ({ code, section, label, units }: Record<string, unknown>) => ({
  code,
  section,
  label,
  units,
});

let services: PowerService[] = [];
const service = (fetcher: typeof fetch) => {
  const instance = createPowerService({
    fetch: fetcher,
    config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
  });
  services.push(instance);
  return instance;
};
/** Captured configuration (or `config`), then `point` answers every design-conditions request. */
const upstream = (point: (url: URL) => Response, config: object = configuration) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.href === CONFIGURATION_URL) return Response.json(config);
    if (url.pathname === POINT_PATH) return point(url);
    throw new Error(`Unexpected request ${url.href}`);
  });
const pointCalls = (fetcher: ReturnType<typeof upstream>) =>
  fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === POINT_PATH);
/** Advance past the pacer's start gaps, then settle without an unhandled rejection. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  const guarded = pending.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error;
    },
  );
  await vi.advanceTimersByTimeAsync(10_000);
  return (await guarded)();
}
/** One settled Seattle call; `years` replaces the 2020–2024 window. */
const conditions = (
  target: typeof fetch | PowerService,
  years: Partial<DesignConditionsRequest> = WINDOW,
) =>
  settle(
    (target instanceof Function ? service(target) : target).designConditions(
      { ...SEATTLE, ...years },
      createMockContext(),
    ),
  );
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
});
afterEach(() => {
  for (const instance of services) instance.dispose();
  services = [];
  vi.useRealTimers();
});

describe('PowerService.designConditions', () => {
  it('requests the Indicators point without units and labels every captured key', async () => {
    const fake = fakePower([]);
    const fetcher = vi.fn<typeof fetch>(fake.fetch);
    const result = await conditions(fetcher);
    const endpoint =
      'https://power.larc.nasa.gov/api/application/indicators/point?latitude=47.61&longitude=-122.33&start=2020&end=2024&format=JSON';
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      CONFIGURATION_URL,
      endpoint,
    ]);
    expect(fake.requests.map((url) => url.searchParams.has('units'))).toEqual([false]);
    expect(DesignConditionsSchema.parse(result)).toEqual(result);
    expect(result.request).toEqual({ ...SEATTLE, ...WINDOW });
    expect(result.metadata).toEqual({
      endpointUrl: endpoint,
      fetchedAt: expect.stringMatching(/^2026-11-23T00:00:\d{2}\.\d{3}Z$/),
      cacheHit: false,
      api: { name: 'POWER Indicators API', version: 'v2.9.3' },
      sources: ['SRB', 'SYN1DEG', 'MERRA2', 'POWER'],
      startYear: 2020,
      endYear: 2024,
      returnedCoordinates: { latitude: 47.61, longitude: -122.33, elevation: 110.01 },
      timezoneOffsetInHours: -8,
      standardPressureInKpa: 100.01,
      reportedUnits: { temperature: 'C', wind_speed: 'm/s', precipitation: 'mm' },
    });

    /** Every captured key is catalogued and carries POWER's value unchanged, months January first. */
    const scalars = Object.entries(seattle).filter(([, value]) => typeof value === 'number');
    const objects = Object.entries(seattle).filter(
      ([code, value]) => code !== 'metadata' && typeof value === 'object',
    );
    expect([scalars.length, objects.length]).toEqual([87, 38]);
    expect(Object.fromEntries(result.indicators.map((row) => [row.code, row.value]))).toEqual(
      Object.fromEntries(scalars),
    );
    expect(Object.fromEntries(result.monthly.map((row) => [row.code, row.values]))).toEqual(
      Object.fromEntries(objects.map(([code, value]) => [code, monthValues(value)])),
    );
    /** Every row's section, label and units, in report order. */
    expect(result.indicators.map(described)).toEqual(
      Object.entries(REPORT_SCALARS).flatMap(([section, rows]) =>
        rows.map(([code, label, units]) => ({ code, section, label, units })),
      ),
    );
    expect(result.monthly.map(described)).toEqual(
      REPORT_MONTHS.map(([code, label, units]) => ({ code, section: 'monthly', label, units })),
    );
    expect(result.monthly.find((row) => row.code === 'CD_T2M_AVG')?.values).toEqual([
      5.0, 4.8, 6.6, 8.9, 12.6, 15.6, 18.8, 19.0, 16.3, 11.7, 6.8, 4.6,
    ]);
  });

  it('requests the configured coverage explicitly when years are omitted', async () => {
    const fetcher = upstream(() => Response.json(seattleCoverage));
    const result = await conditions(fetcher, {});
    expect(
      pointCalls(fetcher).map(([input]) => {
        const query = new URL(String(input)).searchParams;
        return [query.get('start'), query.get('end')];
      }),
    ).toEqual([['2001', '2025']]);
    expect(result.request).toEqual({ ...SEATTLE, startYear: 2001, endYear: 2025 });
    /** POWER answers this window with `metadata.timezone: -999`. */
    expect(result.metadata).toMatchObject({
      startYear: 2001,
      endYear: 2025,
      timezoneOffsetInHours: null,
      standardPressureInKpa: 100.01,
    });
    expect(result.indicators.find((row) => row.code === 'CD_DB_996')?.value).toBe(
      seattleCoverage.CD_DB_996,
    );
  });

  it('accepts the shortest configured span at the end of coverage', async () => {
    const fake = fakePower([]);
    const result = await conditions(fake.fetch, { startYear: 2021, endYear: 2025 });
    expect(result.request).toMatchObject({ startYear: 2021, endYear: 2025 });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    ['one start year alone', { startYear: 2020 }, true],
    ['one end year alone', { endYear: 2024 }, true],
    ['reversed years', { startYear: 2024, endYear: 2020 }, false],
    ['a 4-year span', { startYear: 2021, endYear: 2024 }, false],
    ['a start before coverage', { startYear: 2000, endYear: 2024 }, false],
    ['an end after coverage', { startYear: 2020, endYear: 2026 }, false],
  ])('refuses %s before any data request', async (_case, years, unpaired) => {
    const fetcher = upstream(() => Response.json(seattle));
    const error = await conditions(fetcher, years).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_window', recovery: { hint: RECOVERIES.invalid_window } },
      message: expect.stringContaining(COVERAGE),
    });
    expect((error as Error).message.includes('Supply startYear and endYear together')).toBe(
      unpaired,
    );
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([CONFIGURATION_URL]);
  });

  it('builds the refusal from the served configuration, not fixed years', async () => {
    const fetcher = upstream(() => Response.json(seattle), {
      settings: { start: '1995-01-01T00:00:00', end: '2030-12-31T00:00:00', range: 3 },
    });
    const instance = service(fetcher);
    const accepted = await conditions(instance, { startYear: 2026, endYear: 2028 });
    expect(accepted.request).toMatchObject({ startYear: 2026, endYear: 2028 });
    await expect(conditions(instance, { startYear: 1994, endYear: 2000 })).rejects.toMatchObject({
      data: { reason: 'invalid_window' },
      message: expect.stringContaining(
        'Design-condition years must fall within 1995 to 2030 and span at least 3 years.',
      ),
    });
    expect(pointCalls(fetcher)).toHaveLength(1);
  });

  it('reads the configuration once at the reference TTL across year windows', async () => {
    const fake = fakePower([]);
    const fetcher = vi.fn<typeof fetch>(fake.fetch);
    const instance = service(fetcher);
    await conditions(instance);
    await conditions(instance, { startYear: 2015, endYear: 2024 });
    const configurationCalls = fetcher.mock.calls.filter(
      ([input]) => String(input) === CONFIGURATION_URL,
    );
    expect(configurationCalls).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
  });

  it('fails a configuration without a minimum span as a shape error before any data request', async () => {
    const fetcher = upstream(() => Response.json(seattle), {
      settings: { start: '2001-01-01T00:00:00', end: '2025-12-31T00:00:00' },
    });
    await expect(conditions(fetcher, {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { retryable: false },
    });
    expect(pointCalls(fetcher)).toHaveLength(0);
  });

  it('turns fills and absent months into null and keeps keys missing from the table', async () => {
    /** No provenance headers: version and sources stay absent rather than invented. */
    const result = await conditions(upstream(() => Response.json(sparse)));
    expect(DesignConditionsSchema.parse(result)).toEqual(result);
    const scalar = (code: string) => result.indicators.find((row) => row.code === code);
    const monthly = (code: string) => result.monthly.find((row) => row.code === code);
    expect(scalar('CD_DB_996')).toMatchObject({ label: 'Heating dry-bulb, 99.6%', value: null });
    /** The fixture drops July: August keeps its own position rather than sliding into July's. */
    expect(monthly('CD_T2M_AVG')?.values).toEqual(monthValues(seattle.CD_T2M_AVG).with(6, null));
    expect(monthly('CD_RADIATION_AVG')?.values.slice(0, 2)).toEqual([null, 1.8]);
    expect(scalar('CD_WM')).toBeUndefined();
    expect(monthly('CD_CLRSKY_SFC_SW_DNI_NOON_HOUR')).toBeUndefined();
    expect(scalar('CD_FUTURE_SCALAR')).toEqual({
      code: 'CD_FUTURE_SCALAR',
      section: null,
      label: null,
      units: null,
      value: 3.5,
    });
    expect(monthly('CD_FUTURE_MONTHLY')).toEqual({
      code: 'CD_FUTURE_MONTHLY',
      section: null,
      label: null,
      units: null,
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, null],
    });
    expect([result.indicators.length, result.monthly.length]).toEqual([87, 38]);
    /** Catalogued keys keep the table order; keys missing from it follow. */
    expect(result.indicators.at(-1)?.code).toBe('CD_FUTURE_SCALAR');
    expect(result.monthly.at(-1)?.code).toBe('CD_FUTURE_MONTHLY');
    expect(result.metadata).toMatchObject({
      api: { name: 'POWER Indicators API' },
      timezoneOffsetInHours: null,
      standardPressureInKpa: null,
      returnedCoordinates: { elevation: 110.01 },
    });
    expect(result.metadata.api).not.toHaveProperty('version');
    expect(result.metadata).not.toHaveProperty('sources');
  });

  it('returns empty lists for a payload that carries only metadata', async () => {
    const result = await conditions(upstream(() => Response.json({ metadata: seattle.metadata })));
    expect([result.indicators, result.monthly]).toEqual([[], []]);
  });

  it('takes units, period and coordinates from the payload, not the request', async () => {
    /** The Seattle body reporting °F and no precipitation unit, for a period and cell not sent. */
    const payload = {
      ...seattle,
      metadata: {
        ...seattle.metadata,
        lat: 47.5,
        lon: -122.5,
        start: 2019,
        end: 2023,
        units: { temperature: 'F', wind_speed: 'm/s' },
      },
    };
    const result = await conditions(upstream(() => Response.json(payload)));
    expect(result.request).toEqual({ ...SEATTLE, ...WINDOW });
    expect(result.metadata).toMatchObject({
      startYear: 2019,
      endYear: 2023,
      returnedCoordinates: { latitude: 47.5, longitude: -122.5, elevation: 110.01 },
    });
    expect(result.metadata.reportedUnits).toEqual({ temperature: 'F', wind_speed: 'm/s' });
    const units = (rows: { code: string; units: string | null }[], code: string) =>
      rows.find((row) => row.code === code)?.units;
    expect([
      units(result.indicators, 'CD_DB_996'),
      units(result.monthly, 'CD_T2M_AVG'),
      units(result.indicators, 'CD_WS_CM_004'),
      units(result.indicators, 'CD_PRECTOTCORR_SUM'),
      units(result.monthly, 'CD_PRECTOTCORR'),
      units(result.indicators, 'CD_MCHR_996'),
    ]).toEqual(['F', 'F', 'm/s', null, null, 'g/kg']);
  });

  it.each([
    ['a text value', { ...seattle, CD_DB_996: 'n/a' }],
    [
      'a month outside 1-12',
      { ...seattle, CD_T2M_AVG: { ...(seattle.CD_T2M_AVG as object), 13: 1 } },
    ],
    ['a month value that is not a number', { ...seattle, CD_T2M_AVG: { 1: null } }],
    [
      'no metadata',
      Object.fromEntries(Object.entries(seattle).filter(([code]) => code !== 'metadata')),
    ],
  ])('fails %s as a shape error without retrying', async (_case, body) => {
    const fetcher = upstream(() => Response.json(body));
    await expect(conditions(fetcher)).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { retryable: false },
    });
    expect(pointCalls(fetcher)).toHaveLength(1);
  });

  it('keeps residual NASA rejections as upstream_rejected without retrying', async () => {
    const fetcher = upstream(() => Response.json(spanRejected, { status: 422 }));
    await expect(conditions(fetcher)).rejects.toMatchObject({
      data: {
        reason: 'upstream_rejected',
        retryable: false,
        messages: spanRejected.messages,
        recovery: { hint: RECOVERIES.upstream_rejected },
      },
    });
    expect(pointCalls(fetcher)).toHaveLength(1);
  });

  it('stops on a 429 as upstream_rate_limited with the retry delay', async () => {
    const fetcher = upstream(() =>
      Response.json({ messages: ['slow down'] }, { status: 429, headers: { 'Retry-After': '7' } }),
    );
    await expect(conditions(fetcher)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited', retryAfter: '7' },
    });
    expect(pointCalls(fetcher)).toHaveLength(1);
  });

  it('sheds callers past the bounded queue as request_queue_full', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const instance = service(fetcher);
    const calls = Array.from({ length: 34 }, () =>
      instance.designConditions(SEATTLE, createMockContext()).catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await calls.at(-1)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'request_queue_full', recovery: { hint: RECOVERIES.request_queue_full } },
    });
    instance.dispose();
    await Promise.all(calls);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an out-of-range latitude',
      { latitude: 95, longitude: 0 },
      { code: 'too_big', maximum: 90, path: ['latitude'] },
    ],
    [
      'a fractional year',
      { ...SEATTLE, startYear: 2020.5, endYear: 2024 },
      { code: 'invalid_type', expected: 'int', path: ['startYear'] },
    ],
    [
      'a units field',
      { ...SEATTLE, units: 'imperial' },
      { code: 'unrecognized_keys', keys: ['units'], path: [] },
    ],
  ])('rejects %s at the request schema before any request', async (_case, input, issue) => {
    const fetcher = upstream(() => Response.json(seattle));
    await expect(
      service(fetcher).designConditions(input as DesignConditionsRequest, createMockContext()),
    ).rejects.toMatchObject({ name: 'ZodError', issues: [issue] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
