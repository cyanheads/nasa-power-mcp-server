/** @fileoverview Scientific request, source and output contracts. @module services/power/types */
import { z } from '@cyanheads/mcp-ts-core';
import { type Preset, WIND_SURFACES } from './presets.js';

/** JSON-compatible metadata preserves unfamiliar upstream fields. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const extra = z.record(z.string(), JsonValueSchema).describe('Additional upstream JSON fields');
/** Parameter/community codes are normalized before service validation. */
export const CodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .describe('NASA POWER parameter code');
export const CommunitySchema = z
  .enum(['RE', 'SB', 'AG'])
  .describe('NASA community controlling parameter units');
export const ResolutionSchema = z
  .enum(['hourly', 'daily', 'monthly', 'climatology'])
  .describe('Source temporal resolution');
export type Community = z.infer<typeof CommunitySchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
/** Explicit preset or parameter selection. */
export const SelectionSchema = z
  .discriminatedUnion('mode', [
    z
      .strictObject({
        mode: z.literal('preset').describe('Select a named group'),
        preset: z
          .enum(['solar_pv', 'wind_turbine', 'building_hvac', 'agroclimatology', 'water_balance'])
          .describe('Parameter group from nasa_power_list_reference topic presets'),
      })
      .describe('Named preset selection'),
    z
      .strictObject({
        mode: z.literal('parameters').describe('Select exact codes'),
        parameters: z
          .array(CodeSchema)
          .min(1)
          .max(20)
          .describe(
            'Unique codes from nasa_power_search_parameters for the selected community and temporalResolution; PSC/WSC corrections count toward the effective limit',
          ),
      })
      .describe('Explicit parameter selection'),
  ])
  .describe('Parameter selection');
export type Selection = z.infer<typeof SelectionSchema>;
const hourlySelection = z
  .discriminatedUnion('mode', [
    SelectionSchema.options[0],
    SelectionSchema.options[1]
      .extend({
        parameters: SelectionSchema.options[1].shape.parameters.max(15),
      })
      .describe('Explicit hourly parameter selection'),
  ])
  .default({ mode: 'preset', preset: 'solar_pv' })
  .describe('Hourly parameter selection; at most 15 effective codes including PSC/WSC corrections');
const latitude = z.number().min(-90).max(90).describe('Latitude in degrees north');
const longitude = z.number().min(-180).max(180).describe('Longitude in degrees east');
/** Validate real Gregorian dates without manufacturing timestamps. */
export function isDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isDate, 'Expected a real Gregorian YYYY-MM-DD date')
  .describe('Inclusive Gregorian date in YYYY-MM-DD format');
const year = z.number().int().min(1981).max(9999).describe('Calendar year');
const common = {
  community: CommunitySchema.default('RE'),
  units: z
    .enum(['metric', 'imperial'])
    .default('metric')
    .describe('Requested units mode; response units remain authoritative'),
  timeStandard: z.enum(['LST', 'UTC']).default('LST').describe('Local solar time or UTC'),
};
const point = {
  ...common,
  latitude,
  longitude,
  selection: SelectionSchema.default({ mode: 'preset', preset: 'solar_pv' }),
  siteElevation: z
    .number()
    .optional()
    .describe(
      'Site elevation in meters; supplying it adds PSC to the effective parameter selection',
    ),
  windElevation: z
    .number()
    .min(10)
    .max(300)
    .optional()
    .describe(
      'Wind correction height in meters; requires windSurface and adds WSC to the effective parameter selection',
    ),
  windSurface: z
    .enum([
      ...(Object.keys(WIND_SURFACES) as (keyof typeof WIND_SURFACES)[]),
      'airport_ice',
      'airport ice',
    ])
    .optional()
    .describe(
      'Wind surface paired with windElevation; airport_ice and airport ice alias airportice',
    ),
};
const windows = {
  hourly: {
    temporalResolution: z.literal('hourly').describe('Hourly observations'),
    startDate: date,
    endDate: date,
  },
  daily: {
    temporalResolution: z.literal('daily').default('daily').describe('Daily observations'),
    startDate: date,
    endDate: date,
  },
  monthly: {
    temporalResolution: z.literal('monthly').describe('Monthly and annual observations'),
    startYear: year,
    endYear: year,
  },
  climatology: {
    temporalResolution: z.literal('climatology').describe('Monthly and annual climatology'),
    startYear: year.optional(),
    endYear: year.optional(),
  },
};
/** Strict point request retaining resolution/window discrimination. */
export const PowerRequestSchema = z.discriminatedUnion('temporalResolution', [
  z
    .strictObject({ ...point, ...windows.hourly, selection: hourlySelection })
    .describe('Hourly point request'),
  z.strictObject({ ...point, ...windows.daily }).describe('Daily point request'),
  z.strictObject({ ...point, ...windows.monthly }).describe('Monthly point request'),
  z.strictObject({ ...point, ...windows.climatology }).describe('Climatology point request'),
]);
export type PowerRequest = z.infer<typeof PowerRequestSchema>;
const region = {
  ...common,
  latitudeMin: latitude,
  latitudeMax: latitude,
  longitudeMin: longitude,
  longitudeMax: longitude,
  parameter: CodeSchema.describe(
    'One code from nasa_power_search_parameters for the selected community and temporalResolution; point corrections PSC/WSC are unsupported',
  ),
};
/** Region requests intentionally exclude point-only correction fields. */
export const RegionRequestSchema = z.discriminatedUnion('temporalResolution', [
  z.strictObject({ ...region, ...windows.daily }).describe('Daily regional request'),
  z.strictObject({ ...region, ...windows.monthly }).describe('Monthly regional request'),
  z
    .strictObject(
      { ...region, temporalResolution: windows.climatology.temporalResolution },
      {
        error: (issue) =>
          issue.code === 'unrecognized_keys' &&
          issue.keys.some((key) => key === 'startYear' || key === 'endYear')
            ? 'Regional climatology accepts no year fields. Omit startYear and endYear, or use nasa_power_get_climatology for custom point years.'
            : undefined,
      },
    )
    .describe('Precomputed regional climatology; use point climatology for custom years'),
]);
export type RegionRequest = z.infer<typeof RegionRequestSchema>;
const { latitude: _lat, longitude: _lon, ...comparisonShared } = point;
const comparison = {
  ...comparisonShared,
  locations: z
    .array(
      z
        .strictObject({
          latitude,
          longitude,
          label: z.string().min(1).max(120).describe('Verbatim caller label'),
        })
        .describe('One labeled coordinate in stable input order'),
    )
    .min(2)
    .max(10)
    .describe('Locations in stable input order'),
  sort: z
    .strictObject({
      parameter: CodeSchema.describe(
        'Selected numeric parameter code to sort; units must be known and identical across successful locations',
      ),
      direction: z.enum(['asc', 'desc']).describe('Numeric sort direction'),
    })
    .optional()
    .describe('Optional comparable annual or observation mean sort'),
};
/** Comparison orchestration contract, separate from the point service. */
export const CompareRequestSchema = z.discriminatedUnion('temporalResolution', [
  z
    .strictObject({ ...comparison, ...windows.hourly, selection: hourlySelection })
    .describe('Hourly comparison request'),
  z
    .strictObject({
      ...comparison,
      ...windows.daily,
      temporalResolution: z.literal('daily').describe('Daily comparison'),
    })
    .describe('Daily comparison request'),
  z.strictObject({ ...comparison, ...windows.monthly }).describe('Monthly comparison request'),
  z
    .strictObject({
      ...comparison,
      ...windows.climatology,
      temporalResolution: z
        .literal('climatology')
        .default('climatology')
        .describe('Climatology comparison'),
    })
    .describe('Climatology comparison request'),
]);
export type CompareRequest = z.infer<typeof CompareRequestSchema>;
/** Output echoes validated requests; window fields occur once instead of repeating input branches. */
const normalizedWindow = {
  temporalResolution: ResolutionSchema,
  startDate: z.string().optional().describe('Inclusive start date for hourly or daily data'),
  endDate: z.string().optional().describe('Inclusive end date for hourly or daily data'),
  startYear: z
    .number()
    .int()
    .optional()
    .describe('Start calendar year for monthly or custom climatology data'),
  endYear: z
    .number()
    .int()
    .optional()
    .describe('End calendar year for monthly or custom climatology data'),
};
const normalizedPoint = {
  ...point,
  selection: z
    .object({
      mode: z.enum(['preset', 'parameters']).describe('Normalized selection mode'),
      preset: SelectionSchema.options[0].shape.preset.optional(),
      parameters: z
        .array(z.string().describe('Normalized unique parameter code'))
        .optional()
        .describe('Codes in first-seen order for explicit selection'),
    })
    .describe('Normalized preset or explicit code selection'),
};
/** Compact typed scientific request provenance; input schemas own validation. */
export const NormalizedPowerRequestSchema = z.object({ ...normalizedPoint, ...normalizedWindow });
/** Climatology echoes have no date window. */
export const NormalizedClimatologyRequestSchema = NormalizedPowerRequestSchema.omit({
  startDate: true,
  endDate: true,
}).extend({
  temporalResolution: z.literal('climatology').describe('Monthly and annual climatology'),
});
/** Regional provenance retains every bound and the single effective parameter. */
export const NormalizedRegionRequestSchema = z.object({ ...region, ...normalizedWindow });
const { latitude: _outputLat, longitude: _outputLon, ...normalizedComparison } = normalizedPoint;
/** Comparison provenance keeps original location order and the requested sort. */
export const NormalizedCompareRequestSchema = z.object({
  ...normalizedComparison,
  ...normalizedWindow,
  locations: comparison.locations,
  sort: comparison.sort,
});
/** Exact period classifications prevent annual/monthly mixing. */
export const PeriodKindSchema = z
  .enum(['hour', 'day', 'month', 'annual', 'climatology_month', 'climatology_annual'])
  .describe('Original source period classification; annual records remain separate');
export type PeriodKind = z.infer<typeof PeriodKindSchema>;
/** Parameter metadata, including dynamic tilted-profile members. */
export const ParameterMetadataSchema = z.object({
  code: CodeSchema,
  longName: z.string().optional().describe('Long parameter name supplied by NASA'),
  units: z.string().optional().describe('Exact source units without conversion'),
  valueKind: z
    .enum(['number', 'categorical', 'orientation'])
    .describe('Numeric measurement, numeric category code or orientation text'),
  extra,
});
export type ParameterMetadata = z.infer<typeof ParameterMetadataSchema>;
/** Provenance uses only fields actually returned by NASA. */
export const PowerMetadataSchema = z.object({
  endpointUrl: z.string().describe('Exact NASA endpoint URL used for retrieval'),
  fetchedAt: z.string().describe('Original retrieval timestamp, retained on cache hits'),
  cacheHit: z.boolean().describe('Whether this response reuses cached source data'),
  api: z
    .object({
      name: z.string().optional().describe('Reported source API name'),
      version: z.string().optional().describe('Reported source API version'),
    })
    .optional()
    .describe('Reported API identity'),
  sources: z
    .array(z.string().describe('Source dataset identifier'))
    .optional()
    .describe('Source datasets reported by NASA'),
  fillValue: z.number().optional().describe('Original source missing-value sentinel'),
  timeStandard: z
    .string()
    .optional()
    .describe('Actual response time standard; LST has no UTC offset'),
  unitsMode: z.enum(['metric', 'imperial']).describe('Requested units mode'),
  messages: z
    .array(z.string().describe('Unmodified upstream message'))
    .describe('NASA messages preserved as data'),
  reportedStart: z.string().optional().describe('Original source start-window identifier'),
  reportedEnd: z.string().optional().describe('Original source end-window identifier'),
  range: z.string().optional().describe('Original climatology range explanation'),
  requestedCoordinates: z
    .object({ latitude, longitude })
    .optional()
    .describe('Requested point coordinates'),
  returnedCoordinates: z
    .object({
      latitude,
      longitude,
      elevation: z.number().nullable().describe('Returned elevation in meters, unknown when null'),
    })
    .optional()
    .describe('Returned point coordinates and source elevation; not proof of a grid center'),
  extra,
});
export type PowerMetadata = z.infer<typeof PowerMetadataSchema>;
/** One observation, with explicitly typed dynamic scientific columns. */
export const ObservationRowSchema = z
  .object({
    periodKey: z.string().describe('Original lossless upstream period identifier'),
    periodKind: PeriodKindSchema,
    date: z.string().nullable().describe('Normalized date/hour text; null for undated aggregates'),
    year: z.number().nullable().describe('Calendar year when the source key has one'),
    month: z.number().nullable().describe('Month 1 through 12; null for annual records'),
    hour: z.number().nullable().describe('Hour 0 through 23 for hourly observations'),
    latitude,
    longitude,
    elevation: z.number().nullable().describe('Source elevation in meters, unknown when null'),
  })
  .catchall(
    z
      .union([z.string(), z.number(), z.null()])
      .describe('Returned parameter value or cell/location identity'),
  );
export type ObservationRow = z.infer<typeof ObservationRowSchema>;
/** Missing counts retain absent-key and explicit-fill provenance. */
export const NumericSummarySchema = z.object({
  parameter: z.string().describe('Parameter code summarized independently'),
  periodKind: PeriodKindSchema,
  units: z.string().optional().describe('Exact source units for this statistic'),
  validCount: z.number().describe('Number of valid numeric values'),
  missingCount: z.number().describe('Fill count plus absent-key count'),
  fillCount: z.number().describe('Returned values matching the source fill sentinel'),
  absentKeyCount: z.number().describe('Union period keys absent from this returned series'),
  firstReturnedKey: z.string().nullable().describe('First returned union key in this period kind'),
  lastReturnedKey: z.string().nullable().describe('Last returned union key in this period kind'),
  lastValidPeriodKey: z.string().nullable().describe('Latest period key containing a valid number'),
  lastValidDate: z
    .string()
    .nullable()
    .describe('Latest valid chronological date; null for undated aggregates'),
  mean: z
    .number()
    .nullable()
    .describe('Arithmetic observation mean; null when no valid values exist'),
  min: z.number().nullable().describe('Minimum valid observation; null when none exist'),
  max: z.number().nullable().describe('Maximum valid observation; null when none exist'),
});
export type NumericSummary = z.infer<typeof NumericSummarySchema>;
const omissions = z
  .array(
    z
      .object({
        code: z.string().describe('Requested code with no returned series'),
        messages: z
          .array(z.string().describe('Applicable NASA message'))
          .describe('Source messages associated with omission'),
      })
      .describe('One requested parameter with no returned series'),
  )
  .describe('Requested parameters omitted by the source, distinct from fill values');
/** Scientific envelope before canvas presentation. */
export const PowerDatasetSchema = z.object({
  request: NormalizedPowerRequestSchema.describe('Normalized scientific request and corrections'),
  metadata: PowerMetadataSchema.describe('Original source provenance and access information'),
  parameters: z
    .array(ParameterMetadataSchema.describe('Returned scientific parameter metadata'))
    .describe('Returned parameter columns, including dynamic alias members'),
  expansions: z
    .record(
      z.string(),
      z.array(z.string().describe('Returned alias member')).describe('Returned member codes'),
    )
    .describe('Requested alias to actual returned member codes'),
  omittedParameters: omissions,
  summaries: z
    .array(NumericSummarySchema.describe('One parameter/period-kind summary'))
    .describe('Numeric observation summaries with explicit missingness'),
  rows: z
    .array(ObservationRowSchema.describe('One original returned period'))
    .describe(
      'Complete inline observations or bounded preview with a full-data handle and exact rowCount',
    ),
});
export type PowerDataset = Omit<z.infer<typeof PowerDatasetSchema>, 'request'> & {
  request: PowerRequest;
};
/** Cross-cell statistics are per parameter and original period. */
export const CellSummarySchema = z.object({
  parameter: z.string().describe('Parameter code compared across grid cells'),
  periodKey: z.string().describe('Original period key shared across cells'),
  periodKind: PeriodKindSchema,
  units: z.string().optional().describe('Exact source units'),
  validCellCount: z.number().describe('Cells with a valid numeric value at this period'),
  missingCellCount: z.number().describe('Cells lacking a valid numeric value at this period'),
  min: z.number().nullable().describe('Minimum valid cell value'),
  mean: z.number().nullable().describe('Equal-weight grid-cell mean; not area-weighted'),
  max: z.number().nullable().describe('Maximum valid cell value'),
});
export type CellSummary = z.infer<typeof CellSummarySchema>;
export const RegionalDatasetSchema = PowerDatasetSchema.omit({
  request: true,
  summaries: true,
}).extend({
  request: NormalizedRegionRequestSchema.describe(
    'Normalized regional bounds, window and parameter',
  ),
  cellCount: z.number().describe('Total features returned by NASA'),
  summaries: z
    .array(CellSummarySchema.describe('One parameter/period cross-cell statistic'))
    .describe('Cross-cell summaries kept separate for every period'),
});
export type RegionalDataset = Omit<z.infer<typeof RegionalDatasetSchema>, 'request'> & {
  request: RegionRequest;
};
/** Temporary full-table pointer returned by the presentation service. */
export const DatasetHandleSchema = z.object({
  canvas_id: z.string().describe('Explicit process-local canvas access token'),
  table: z.string().describe('Registered full-data table name'),
  rowCount: z.number().describe('Exact full staged row count'),
  expiresAt: z.string().describe('Table expiry timestamp'),
  columns: z
    .array(
      z
        .object({
          name: z.string().describe('Exact registered column name'),
          type: z.string().describe('Explicit DuckDB column type'),
          nullable: z.boolean().describe('Whether this column permits null values'),
          units: z.string().optional().describe('Exact source units for scientific columns'),
          valueKind: ParameterMetadataSchema.shape.valueKind
            .optional()
            .describe('Scientific value kind when applicable'),
        })
        .describe('One explicitly typed staged column'),
    )
    .describe('Explicit schema of every staged column'),
  describeTool: z
    .literal('nasa_power_dataframe_describe')
    .describe('Tool for inspecting this dataset'),
  queryTool: z.literal('nasa_power_dataframe_query').describe('Tool for querying this dataset'),
});
export type DatasetHandle = z.infer<typeof DatasetHandleSchema>;
/** Calendar-bucket completeness, independent of hemisphere. */
export type BucketSummary = {
  parameter: string;
  locationId: string;
  units?: string;
  bucket: 'annual' | 'DJF' | 'MAM' | 'JJA' | 'SON';
  year: number | null;
  method: 'observation_mean' | 'monthly_mean' | 'source_annual' | 'climatology_month_mean';
  includedPeriods: number;
  returnedPeriods: number;
  expectedPeriods: number;
  complete: boolean;
  windowClipped: boolean;
  mean: number | null;
};
/** Complete source dictionary with sparse, explicitly modeled fields. */
export const DictionaryEntrySchema = z
  .object({
    type: z.string().nullable().optional().describe('Source parameter family'),
    temporal: z.string().optional().describe('Source temporal resolution designation'),
    source: z
      .string()
      .nullable()
      .optional()
      .describe('Reported source dataset or calculation provider'),
    community: z.string().optional().describe('Source community designation'),
    calculated: z
      .boolean()
      .optional()
      .describe('Whether NASA reports this parameter as calculated'),
    inputs: JsonValueSchema.optional().describe(
      'Original calculation inputs, including explicit null',
    ),
    units: z.string().nullable().optional().describe('Exact parameter units for the selected pair'),
    name: z.string().nullable().optional().describe('NASA parameter name'),
    definition: z
      .string()
      .nullable()
      .optional()
      .describe('NASA parameter definition preserved verbatim'),
  })
  .catchall(JsonValueSchema);
export const ParameterDictionarySchema = z.record(CodeSchema, DictionaryEntrySchema);
export type ParameterDictionary = z.infer<typeof ParameterDictionarySchema>;
/** Configuration retains source-specific coverage fields without coercion. */
export const PowerConfigurationSchema = z
  .object({
    documentation: z
      .object({
        version: z.string().optional().describe('Reported API version'),
        library: z.string().optional().describe('Reported source library version'),
        title: z.string().optional().describe('Reported product title'),
        description: z.string().optional().describe('Source product description'),
        contact: z.string().optional().describe('Source product contact'),
      })
      .catchall(JsonValueSchema)
      .optional()
      .describe('Product documentation supplied by NASA'),
    settings: z
      .object({
        community: z
          .array(z.string().describe('Supported community code'))
          .optional()
          .describe('Communities supported by this product'),
        start: z.string().optional().describe('Configured product start timestamp'),
        end: z.string().optional().describe('Configured product end timestamp'),
        formats: JsonValueSchema.optional().describe(
          'Original advertised output formats when supplied',
        ),
      })
      .catchall(JsonValueSchema)
      .optional()
      .describe('Source product coverage and output settings'),
  })
  .catchall(JsonValueSchema);
export type PowerConfiguration = z.infer<typeof PowerConfigurationSchema>;
/** Access information is injected independently of scientific payloads. */
export type AccessMetadata = {
  endpointUrl: string;
  fetchedAt: string;
  cacheHit: boolean;
  effectiveParameters?: string[];
};
export type { Preset };
