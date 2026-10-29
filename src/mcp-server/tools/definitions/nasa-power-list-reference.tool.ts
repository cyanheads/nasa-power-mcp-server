/** @fileoverview Typed source and workspace guidance. @module mcp-server/tools/definitions/nasa-power-list-reference.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig, POWER_LIMITS } from '@/config/server-config.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { PRESETS, presetParameters, TILTED_ALIAS, WIND_SURFACES } from '@/services/power/index.js';

const TopicSchema = z
  .enum(['presets', 'communities', 'coverage', 'missing_data', 'wind_surfaces', 'dataframes'])
  .describe('Reference topic');
const EntrySchema = z.object({
  code: z.string().describe('Reference identifier'),
  description: z.string().describe('Scientific meaning and limitations'),
  parameters: z.array(z.string()).optional().describe('Exact requested preset codes'),
  members: z
    .array(z.string())
    .optional()
    .describe('Verified returned members of a request alias; new source members remain preserved'),
  resolutions: z.array(z.string()).optional().describe('Supported source temporal resolutions'),
  aliases: z.array(z.string()).optional().describe('Accepted one-to-one aliases'),
  earliestDate: z.string().optional().describe('Earliest source date for this family'),
  minimumInMeters: z.number().optional().describe('Minimum supported wind height in meters'),
  maximumInMeters: z.number().optional().describe('Maximum supported wind height in meters'),
  available: z.boolean().optional().describe('Whether the analytical provider is configured'),
  dropEnabled: z.boolean().optional().describe('Whether explicit table removal is enabled'),
  tableTtlInMs: z.number().optional().describe('Sliding staged-table TTL in milliseconds'),
  canvasTtlInMs: z.number().optional().describe('Sliding canvas TTL in milliseconds'),
  absoluteLifetimeInMs: z.number().optional().describe('Absolute canvas lifetime in milliseconds'),
});
const allResolutions = ['hourly', 'daily', 'monthly', 'climatology'];

/** Explain choices without fetching source observations. */
export const listReferenceTool = tool('nasa_power_list_reference', {
  title: 'List NASA POWER reference',
  description:
    'Explain exact presets, communities and units, source coverage, missing values, wind corrections or current dataframe availability. Choose topic presets before a producing call, or coverage when revising a date window. Reference entries include public documentation and verification dates.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({ topic: TopicSchema.default('presets') }),
  output: z.object({
    topic: TopicSchema,
    verifiedOn: z.string().describe('Date the source reference was verified'),
    documentationUrls: z.array(z.string()).describe('Canonical public NASA documentation links'),
    entries: z
      .array(EntrySchema.describe('One typed scientific reference entry'))
      .describe('Typed entries for the selected reference topic'),
    guidance: z.array(z.string()).describe('Scientific interpretation and next-call guidance'),
  }),
  handler({ topic }) {
    const entries: z.infer<typeof EntrySchema>[] = [];
    const guidance: string[] = [];
    if (topic === 'presets') {
      for (const code of Object.keys(PRESETS) as (keyof typeof PRESETS)[])
        for (const resolutions of code === 'agroclimatology'
          ? [['hourly'], allResolutions.slice(1)]
          : [code === 'building_hvac' ? allResolutions.slice(1) : allResolutions])
          entries.push({
            code,
            parameters: presetParameters(code, resolutions.includes('hourly') ? 'hourly' : 'daily'),
            resolutions,
            description:
              code === 'water_balance'
                ? 'Related precipitation, evapotranspiration and soil-wetness observations; incompatible units prohibit direct subtraction.'
                : code === 'agroclimatology' && resolutions[0] !== 'hourly'
                  ? 'Includes source-period maximum and minimum temperature; monthly and climatology extremes are source aggregates, not reconstructed daily records or calculated growing degree days. Growing degree days (GDD*) are served at daily resolution only; sum the daily values for a monthly or seasonal total.'
                  : 'Exact parameter group, validated against the selected community/resolution dictionary at retrieval.',
          });
      entries.push({
        code: TILTED_ALIAS,
        resolutions: ['climatology'],
        members: [
          'SI_TILTED_AVG_HORIZONTAL',
          'SI_TILTED_AVG_LAT_MINUS15',
          'SI_TILTED_AVG_LATITUDE',
          'SI_TILTED_AVG_LAT_PLUS15',
          'SI_TILTED_AVG_VERTICAL',
          'SI_TILTED_AVG_OPTIMAL',
          'SI_TILTED_AVG_OPTIMAL_ANG',
          'SI_TILTED_AVG_OPTIMAL_ANG_ORT',
        ],
        description:
          'Tilted solar profile alias with dynamic returned members, including numeric optimal angle and string N/S orientation. Returned metadata defines the actual columns.',
      });
      guidance.push(
        'Presets retain the selected community. Corrections add PSC or WSC once before enforcing the parameter cap. building_hvac is unavailable hourly.',
      );
    } else if (topic === 'communities') {
      entries.push(
        {
          code: 'RE',
          description: 'Renewable Energy community; solar irradiation commonly uses kW-hr/m^2/day.',
        },
        {
          code: 'SB',
          description:
            'Sustainable Buildings community; daily solar irradiance commonly uses W m-2.',
        },
        {
          code: 'AG',
          description: 'Agroclimatology community; solar irradiation commonly uses MJ/m^2/day.',
        },
      );
      guidance.push(
        'Community changes physical units. Exact returned parameter units are authoritative; metric and imperial request modes do not make unlike quantities comparable.',
      );
    } else if (topic === 'coverage') {
      entries.push(
        {
          code: 'meteorology',
          earliestDate: '1981-01-01',
          resolutions: ['daily', 'monthly', 'climatology'],
          description:
            'Meteorological source coverage begins in 1981; product configuration defines the supported window.',
        },
        {
          code: 'solar',
          earliestDate: '1984-01-01',
          resolutions: allResolutions,
          description:
            'Solar source coverage begins in 1984. Earlier mixed requests can omit solar while returning meteorology; solar-only requests can fail.',
        },
        {
          code: 'hourly',
          earliestDate: '2001-01-01',
          resolutions: ['hourly'],
          description:
            'Hourly coverage begins in 2001. Endpoint dates include every source hour; LST labels have no UTC offset.',
        },
      );
      guidance.push(
        'Recent records can be missing because release latency differs by product; current dates are allowed without guaranteeing valid observations.',
        'Monthly annual keys and climatology ANN remain separate from monthly records. Custom point climatology years must be paired and within current product configuration. Regional climatology accepts no year fields and reports its precomputed source period; use nasa_power_get_climatology for custom point years.',
      );
    } else if (topic === 'missing_data') {
      entries.push(
        {
          code: 'null',
          description: 'Source fill values become null; zero remains a measurement.',
        },
        {
          code: 'omitted_parameter',
          description:
            'A requested parameter with no returned series is reported in omittedParameters, without invented rows or statistics.',
        },
        {
          code: 'absent_key',
          description:
            'An absent period within a returned series becomes null on the union of returned keys; absentKeyCount remains separate from fillCount.',
        },
        {
          code: 'observation_mean',
          description:
            'Arithmetic means use valid numbers within each period kind. They are not weighted climate normals, annual energy yields or water balances.',
        },
      );
      guidance.push(
        'No complete requested calendar is synthesized. All-null statistics remain null. Annual records never enter monthly means; orientation strings and categorical T_ZONES/TM_ZONES codes have no arithmetic summaries or numeric comparison sort metrics. Climate-zone codes remain numeric in observations and SQL.',
      );
    } else if (topic === 'wind_surfaces') {
      for (const [code, description] of Object.entries(WIND_SURFACES))
        entries.push({
          code,
          description,
          ...(code === 'airportice' ? { aliases: ['airport_ice', 'airport ice'] } : {}),
          minimumInMeters: 10,
          maximumInMeters: 300,
        });
      entries.push(
        {
          code: 'WSC',
          description:
            'Corrected wind speed requires both windElevation and windSurface; supplying both adds WSC.',
        },
        {
          code: 'PSC',
          description:
            'Pressure correction requires siteElevation in meters; supplying siteElevation adds PSC.',
        },
      );
      guidance.push(
        'Supply both wind settings or neither. Canonical NASA aliases retain underscores; airport_ice and airport ice normalize to airportice.',
      );
    } else {
      entries.push({
        code: 'dataframes',
        description:
          'Explicit canvas tokens authorize access to process-local ephemeral tables. Describe schemas and provenance, then run one bounded read-only SELECT. Native engine memory is not a total RSS or temporary-disk quota.',
        available: config.canvas.providerType === 'duckdb',
        dropEnabled: getServerConfig().dataframeDropEnabled,
        tableTtlInMs: POWER_LIMITS.tableTtlMs,
        canvasTtlInMs: config.canvas.ttlMs,
        absoluteLifetimeInMs: config.canvas.absoluteCapMs,
      });
      guidance.push(
        'Use nasa_power_dataframe_describe and nasa_power_dataframe_query with the exact returned canvas_id. Tokens expire and cannot cross processes.',
        'Oversized comparison summaries have summaryDatasets handles; query in summaryIndex order and group location summaries by locationId. SQL NULL units restore an omitted source unit.',
        'Oversized region, time-series and climatology summaries have a summaryDataset handle and exact summaryCount; query in summaryIndex order to restore every summary.',
        'npm and Docker installs stage larger tables in DuckDB by default; the portable MCPB supports inline data only. Without a native provider, an oversized result is refused with canvas_required listing calls that each fit inline; send those calls.',
      );
      if (getServerConfig().dataframeDropEnabled)
        guidance.push(
          'Use nasa_power_dataframe_drop to remove one explicitly named staged table. Removing the final table retires the canvas; later calls with that token return canvas_not_found.',
        );
    }
    return {
      topic,
      verifiedOn: '2026-10-28',
      documentationUrls: [
        'https://power.larc.nasa.gov/docs/services/api/',
        'https://power.larc.nasa.gov/docs/methodology/',
      ],
      entries,
      guidance,
    };
  },
  format: formatFaithfully,
});
