/** @fileoverview POWER Indicators climatic design conditions: key table, year window and normalizer. @module services/power/design-conditions */
import { powerError } from './errors.js';
import {
  DESIGN_MONTH_KEYS,
  type DesignConditionSection,
  type DesignConditions,
  type DesignConditionsPayload,
  type DesignConditionsRequest,
  type IndicatorsConfiguration,
} from './types.js';

/** POWER's fill sentinel; no design condition can take it. */
const FILL_VALUE = -999;

/** A unit POWER states per response in `metadata.units`, named by its key there. */
type ReportedUnit = { reported: 'temperature' | 'wind_speed' | 'precipitation' };
type KeySpec = { section: DesignConditionSection; label: string; units: string | ReportedUnit };

const TEMP: ReportedUnit = { reported: 'temperature' };
const WIND: ReportedUnit = { reported: 'wind_speed' };
const PRECIP: ReportedUnit = { reported: 'precipitation' };
const MONTH = 'month (1-12)';
const HUMIDITY_RATIO = 'g/kg';
const ENTHALPY = 'kJ/kg';
const DIRECTION = 'degrees';
const DEGREE_DAYS = 'degree-day-c';
const DEGREE_HOURS = 'degree-hour-c';
const IRRADIANCE = 'W/m^2';
const DAILY_RADIATION = 'kW-hr/m^2/day';

const section = (name: DesignConditionSection, rows: [string, string, KeySpec['units']][]) =>
  rows.map(([code, label, units]): [string, KeySpec] => [code, { section: name, label, units }]);

/**
 * Every key the Indicators API returned in v2.9.3, in the order of POWER's own Climatic Design
 * Conditions report (`format=HTML`), labeled from that report with ASHRAE abbreviations expanded.
 * Units the report omits or misstates were confirmed by computation: humidity ratio is g/kg and
 * enthalpy kJ/kg (the report files both under "(°C)"), RadAvg/RadStd are kW-hr/m^2/day (labeled
 * "W m-2", but equal to ALLSKY_SFC_SW_DWN), and prevailing wind direction takes ASHRAE's degrees.
 */
const KEYS: ReadonlyMap<string, KeySpec> = new Map([
  ...section('heating_humidification', [
    ['CD_CM', 'Coldest month', MONTH],
    ['CD_DB_996', 'Heating dry-bulb, 99.6%', TEMP],
    ['CD_DB_990', 'Heating dry-bulb, 99%', TEMP],
    ['CD_DP_996', 'Humidification dew point, 99.6%', TEMP],
    ['CD_MCHR_996', 'Humidity ratio at the 99.6% humidification dew point', HUMIDITY_RATIO],
    ['CD_MCDB_996', 'Mean coincident dry-bulb at the 99.6% humidification dew point', TEMP],
    ['CD_DP_990', 'Humidification dew point, 99%', TEMP],
    ['CD_MCHR_990', 'Humidity ratio at the 99% humidification dew point', HUMIDITY_RATIO],
    ['CD_MCDB_990', 'Mean coincident dry-bulb at the 99% humidification dew point', TEMP],
    ['CD_WS_CM_004', 'Coldest-month wind speed, 0.4%', WIND],
    ['CD_MCDB_CM_004', 'Mean coincident dry-bulb at the 0.4% coldest-month wind speed', TEMP],
    ['CD_WS_CM_010', 'Coldest-month wind speed, 1%', WIND],
    ['CD_MCDB_CM_010', 'Mean coincident dry-bulb at the 1% coldest-month wind speed', TEMP],
    ['CD_MCWS_996', 'Mean coincident wind speed to the 99.6% heating dry-bulb', WIND],
    [
      'CD_MCWD_996',
      'Prevailing coincident wind direction to the 99.6% heating dry-bulb',
      DIRECTION,
    ],
  ]),
  ...section('cooling_dehumidification_enthalpy', [
    ['CD_WM', 'Hottest month', MONTH],
    ['CD_DB_RANGE', 'Hottest-month mean daily dry-bulb range', TEMP],
    ['CD_DB_004', 'Cooling dry-bulb, 0.4%', TEMP],
    ['CD_MCWB_004', 'Mean coincident wet-bulb at the 0.4% cooling dry-bulb', TEMP],
    ['CD_DB_010', 'Cooling dry-bulb, 1%', TEMP],
    ['CD_MCWB_010', 'Mean coincident wet-bulb at the 1% cooling dry-bulb', TEMP],
    ['CD_DB_020', 'Cooling dry-bulb, 2%', TEMP],
    ['CD_MCWB_020', 'Mean coincident wet-bulb at the 2% cooling dry-bulb', TEMP],
    ['CD_WB_004', 'Evaporation wet-bulb, 0.4%', TEMP],
    ['CD_MCDB_WB_004', 'Mean coincident dry-bulb at the 0.4% evaporation wet-bulb', TEMP],
    ['CD_WB_010', 'Evaporation wet-bulb, 1%', TEMP],
    ['CD_MCDB_WB_010', 'Mean coincident dry-bulb at the 1% evaporation wet-bulb', TEMP],
    ['CD_WB_020', 'Evaporation wet-bulb, 2%', TEMP],
    ['CD_MCDB_WB_020', 'Mean coincident dry-bulb at the 2% evaporation wet-bulb', TEMP],
    ['CD_MCWS_DB_004', 'Mean coincident wind speed to the 0.4% cooling dry-bulb', WIND],
    [
      'CD_MCWD_DB_004',
      'Prevailing coincident wind direction to the 0.4% cooling dry-bulb',
      DIRECTION,
    ],
    ['CD_DP_004', 'Dehumidification dew point, 0.4%', TEMP],
    ['CD_MCHR_DP_004', 'Humidity ratio at the 0.4% dehumidification dew point', HUMIDITY_RATIO],
    ['CD_MCDB_DP_004', 'Mean coincident dry-bulb at the 0.4% dehumidification dew point', TEMP],
    ['CD_DP_010', 'Dehumidification dew point, 1%', TEMP],
    ['CD_MCHR_DP_010', 'Humidity ratio at the 1% dehumidification dew point', HUMIDITY_RATIO],
    ['CD_MCDB_DP_010', 'Mean coincident dry-bulb at the 1% dehumidification dew point', TEMP],
    ['CD_DP_020', 'Dehumidification dew point, 2%', TEMP],
    ['CD_MCHR_DP_020', 'Humidity ratio at the 2% dehumidification dew point', HUMIDITY_RATIO],
    ['CD_MCDB_DP_020', 'Mean coincident dry-bulb at the 2% dehumidification dew point', TEMP],
    ['CD_EN_004', 'Enthalpy, 0.4%', ENTHALPY],
    ['CD_MCDB_EN_004', 'Mean coincident dry-bulb at the 0.4% enthalpy', TEMP],
    ['CD_EN_010', 'Enthalpy, 1%', ENTHALPY],
    ['CD_MCDB_EN_010', 'Mean coincident dry-bulb at the 1% enthalpy', TEMP],
    ['CD_EN_020', 'Enthalpy, 2%', ENTHALPY],
    ['CD_MCDB_EN_020', 'Mean coincident dry-bulb at the 2% enthalpy', TEMP],
    ['CD_T2MWET_MAX_VALUE', 'Extreme maximum wet-bulb', TEMP],
  ]),
  ...section('extreme_annual', [
    ['CD_EXT_WS_010', 'Extreme annual wind speed, 1%', WIND],
    ['CD_EXT_WS_025', 'Extreme annual wind speed, 2.5%', WIND],
    ['CD_EXT_WS_050', 'Extreme annual wind speed, 5%', WIND],
    ['CD_DB_MIN_AVG', 'Extreme annual minimum dry-bulb, mean', TEMP],
    ['CD_DB_MAX_AVG', 'Extreme annual maximum dry-bulb, mean', TEMP],
    ['CD_DB_MIN_STD', 'Extreme annual minimum dry-bulb, standard deviation', TEMP],
    ['CD_DB_MAX_STD', 'Extreme annual maximum dry-bulb, standard deviation', TEMP],
    ['CD_DB_EXTREME_MIN_05', '5-year return period minimum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MAX_05', '5-year return period maximum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MIN_10', '10-year return period minimum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MAX_10', '10-year return period maximum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MIN_20', '20-year return period minimum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MAX_20', '20-year return period maximum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MIN_50', '50-year return period minimum dry-bulb', TEMP],
    ['CD_DB_EXTREME_MAX_50', '50-year return period maximum dry-bulb', TEMP],
    ['CD_WB_MIN_AVG', 'Extreme annual minimum wet-bulb, mean', TEMP],
    ['CD_WB_MAX_AVG', 'Extreme annual maximum wet-bulb, mean', TEMP],
    ['CD_WB_MIN_STD', 'Extreme annual minimum wet-bulb, standard deviation', TEMP],
    ['CD_WB_MAX_STD', 'Extreme annual maximum wet-bulb, standard deviation', TEMP],
    ['CD_WB_EXTREME_MIN_05', '5-year return period minimum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MAX_05', '5-year return period maximum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MIN_10', '10-year return period minimum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MAX_10', '10-year return period maximum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MIN_20', '20-year return period minimum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MAX_20', '20-year return period maximum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MIN_50', '50-year return period minimum wet-bulb', TEMP],
    ['CD_WB_EXTREME_MAX_50', '50-year return period maximum wet-bulb', TEMP],
  ]),
  ...section('monthly', [
    ['CD_DB_AVG', 'Annual mean of daily (max+min)/2 dry-bulb', TEMP],
    ['CD_T2M_AVG', 'Monthly mean of daily (max+min)/2 dry-bulb', TEMP],
    ['CD_DB_STD', 'Standard deviation of daily (max+min)/2 dry-bulb over the year', TEMP],
    ['CD_T2M_STD', 'Standard deviation of daily (max+min)/2 dry-bulb within each month', TEMP],
    ['CD_HDD10_SUM', 'Annual heating degree-days, base 10.0 °C', DEGREE_DAYS],
    ['CD_HDD10', 'Monthly heating degree-days, base 10.0 °C', DEGREE_DAYS],
    ['CD_HDD18_SUM', 'Annual heating degree-days, base 18.3 °C', DEGREE_DAYS],
    ['CD_HDD18', 'Monthly heating degree-days, base 18.3 °C', DEGREE_DAYS],
    ['CD_CDD10_SUM', 'Annual cooling degree-days, base 10.0 °C', DEGREE_DAYS],
    ['CD_CDD10', 'Monthly cooling degree-days, base 10.0 °C', DEGREE_DAYS],
    ['CD_CDD18_SUM', 'Annual cooling degree-days, base 18.3 °C', DEGREE_DAYS],
    ['CD_CDD18', 'Monthly cooling degree-days, base 18.3 °C', DEGREE_DAYS],
    ['CD_CDH23_SUM', 'Annual cooling degree-hours, base 23.3 °C', DEGREE_HOURS],
    ['CD_CDH23', 'Monthly cooling degree-hours, base 23.3 °C', DEGREE_HOURS],
    ['CD_CDH26_SUM', 'Annual cooling degree-hours, base 26.7 °C', DEGREE_HOURS],
    ['CD_CDH26', 'Monthly cooling degree-hours, base 26.7 °C', DEGREE_HOURS],
    ['CD_WS10M_ANNUAL', 'Annual mean 10 m wind speed', WIND],
    ['CD_WS10M_MONTH', 'Monthly mean 10 m wind speed', WIND],
    ['CD_PRECTOTCORR_SUM', 'Annual mean precipitation total', PRECIP],
    ['CD_PRECTOTCORR', 'Monthly mean precipitation total', PRECIP],
    ['CD_PRECTOTCORR_ANNUAL_MAX', 'Largest annual precipitation total', PRECIP],
    ['CD_PRECTOTCORR_MONTH_MAX', 'Largest monthly precipitation total', PRECIP],
    ['CD_PRECTOTCORR_ANNUAL_MIN', 'Smallest annual precipitation total', PRECIP],
    ['CD_PRECTOTCORR_MONTH_MIN', 'Smallest monthly precipitation total', PRECIP],
    ['CD_PRECTOTCORR_ANNUAL_STD', 'Standard deviation of annual precipitation totals', PRECIP],
    ['CD_PRECTOTCORR_MONTH_STD', 'Standard deviation of monthly precipitation totals', PRECIP],
    ['CD_DB_TEMP_004', 'Monthly design dry-bulb, 0.4%', TEMP],
    ['CD_MCWB_TEMP_004', 'Mean coincident wet-bulb at the monthly 0.4% design dry-bulb', TEMP],
    ['CD_DB_TEMP_020', 'Monthly design dry-bulb, 2%', TEMP],
    ['CD_MCWB_TEMP_020', 'Mean coincident wet-bulb at the monthly 2% design dry-bulb', TEMP],
    ['CD_DB_TEMP_050', 'Monthly design dry-bulb, 5%', TEMP],
    ['CD_MCWB_TEMP_050', 'Mean coincident wet-bulb at the monthly 5% design dry-bulb', TEMP],
    ['CD_DB_TEMP_100', 'Monthly design dry-bulb, 10%', TEMP],
    ['CD_MCWB_TEMP_100', 'Mean coincident wet-bulb at the monthly 10% design dry-bulb', TEMP],
    ['CD_WB_TEMP_004', 'Monthly design wet-bulb, 0.4%', TEMP],
    ['CD_MCDB_TEMP_004', 'Mean coincident dry-bulb at the monthly 0.4% design wet-bulb', TEMP],
    ['CD_WB_TEMP_020', 'Monthly design wet-bulb, 2%', TEMP],
    ['CD_MCDB_TEMP_020', 'Mean coincident dry-bulb at the monthly 2% design wet-bulb', TEMP],
    ['CD_WB_TEMP_050', 'Monthly design wet-bulb, 5%', TEMP],
    ['CD_MCDB_TEMP_050', 'Mean coincident dry-bulb at the monthly 5% design wet-bulb', TEMP],
    ['CD_WB_TEMP_100', 'Monthly design wet-bulb, 10%', TEMP],
    ['CD_MCDB_TEMP_100', 'Mean coincident dry-bulb at the monthly 10% design wet-bulb', TEMP],
    ['CD_DB_RANGE_MONTH', 'Mean daily dry-bulb range', TEMP],
    ['CD_MCDBR_DB', 'Mean coincident dry-bulb range at the monthly 5% design dry-bulb', TEMP],
    ['CD_MCWBR_DB', 'Mean coincident wet-bulb range at the monthly 5% design dry-bulb', TEMP],
    ['CD_MCDBR_WB', 'Mean coincident dry-bulb range at the monthly 5% design wet-bulb', TEMP],
    ['CD_MCWBR_WB', 'Mean coincident wet-bulb range at the monthly 5% design wet-bulb', TEMP],
    ['CD_CLRSKY_SFC_SW_DNI_NOON_HOUR', 'Clear-sky beam normal irradiance at noon', IRRADIANCE],
    [
      'CD_CLRSKY_SFC_SW_DIFF_NOON_HOUR',
      'Clear-sky diffuse horizontal irradiance at noon',
      IRRADIANCE,
    ],
    ['CD_RADIATION_AVG', 'Mean daily all-sky surface solar radiation', DAILY_RADIATION],
    [
      'CD_RADIATION_STD',
      'Standard deviation of daily all-sky surface solar radiation',
      DAILY_RADIATION,
    ],
  ]),
]);

/**
 * The years sent to POWER: the caller's pair, or the configured coverage when both are omitted.
 * Throws `invalid_window` for one year alone, reversed years, years outside the coverage, or a
 * period shorter than the configured minimum, so no data request is spent on a known refusal.
 */
export function resolveDesignYears(
  request: DesignConditionsRequest,
  configuration: IndicatorsConfiguration,
): { startYear: number; endYear: number } {
  const first = Number(configuration.settings.start.slice(0, 4));
  const last = Number(configuration.settings.end.slice(0, 4));
  const minimum = configuration.settings.range;
  const rule = `Design-condition years must fall within ${first} to ${last} and span at least ${minimum} years.`;
  if ((request.startYear === undefined) !== (request.endYear === undefined))
    throw powerError(
      'invalid_window',
      `${rule} Supply startYear and endYear together, or omit both.`,
    );
  const startYear = request.startYear ?? first;
  const endYear = request.endYear ?? last;
  if (
    startYear > endYear ||
    startYear < first ||
    endYear > last ||
    endYear - startYear + 1 < minimum
  )
    throw powerError('invalid_window', rule);
  return { startYear, endYear };
}

/** Access provenance for one response; version and sources arrive only as response headers. */
type DesignConditionsAccess = {
  endpointUrl: string;
  fetchedAt: string;
  cacheHit: boolean;
  appVersion?: string;
  dataSources?: string;
};

/** A reported number, or null for POWER's fill value or an absent one. */
const known = (value: number | null | undefined): number | null =>
  value === undefined || value === null || value === FILL_VALUE ? null : value;

/**
 * Label every returned key from the table: scalars into `indicators`, month objects into `monthly`
 * January first. Catalogued keys keep report order; a key missing from the table follows with its
 * value and null section, label and units, and a catalogued key POWER omits stays absent.
 */
export function normalizeDesignConditions(
  payload: DesignConditionsPayload,
  request: DesignConditions['request'],
  access: DesignConditionsAccess,
): DesignConditions {
  const { metadata, ...returned } = payload;
  const series = new Map(Object.entries(returned));
  const reportedUnits = metadata.units ?? {};
  const describe = (code: string) => {
    const spec = KEYS.get(code);
    if (!spec) return { code, section: null, label: null, units: null };
    const units =
      typeof spec.units === 'string' ? spec.units : (reportedUnits[spec.units.reported] ?? null);
    return { code, section: spec.section, label: spec.label, units };
  };
  const indicators: DesignConditions['indicators'] = [];
  const monthly: DesignConditions['monthly'] = [];
  for (const code of [...KEYS.keys(), ...[...series.keys()].filter((key) => !KEYS.has(key))]) {
    const value = series.get(code);
    if (value === undefined) continue;
    if (typeof value === 'number') indicators.push({ ...describe(code), value: known(value) });
    else
      monthly.push({
        ...describe(code),
        values: DESIGN_MONTH_KEYS.map((month) => known(value[month])),
      });
  }
  const sources = access.dataSources
    ?.split(',')
    .map((source) => source.trim())
    .filter(Boolean);
  return {
    request,
    metadata: {
      endpointUrl: access.endpointUrl,
      fetchedAt: access.fetchedAt,
      cacheHit: access.cacheHit,
      api: {
        name: 'POWER Indicators API',
        ...(access.appVersion ? { version: access.appVersion } : {}),
      },
      ...(sources?.length ? { sources } : {}),
      startYear: metadata.start,
      endYear: metadata.end,
      returnedCoordinates: {
        latitude: metadata.lat,
        longitude: metadata.lon,
        elevation: known(metadata.elevation),
      },
      timezoneOffsetInHours: known(metadata.timezone),
      standardPressureInKpa: known(metadata.pressure),
      reportedUnits,
    },
    indicators,
    monthly,
  };
}
