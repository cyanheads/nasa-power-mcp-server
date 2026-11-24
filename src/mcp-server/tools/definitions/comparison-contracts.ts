/** @fileoverview Bounded comparison orchestration and scientific output. @module mcp-server/tools/definitions/comparison-contracts */
import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { POWER_LIMITS } from '@/config/server-config.js';
import { getCanvasService, SummaryDatasetsSchema } from '@/services/canvas/index.js';
import { sharedGridCells } from '@/services/canvas/inline-split.js';
import { estimateComparisonBytes } from '@/services/canvas/producer-estimate.js';
import {
  type CompareRequest,
  ComparisonLocationSchema,
  DatasetHandleSchema,
  describePowerError,
  getPowerService,
  NormalizedCompareRequestSchema,
  type ObservationRow,
  ObservationRowSchema,
  type ParameterMetadata,
  type PowerDataset,
  PowerDatasetSchema,
  type PowerRequest,
  powerError,
  requestedParameters,
  summarizeBuckets,
} from '@/services/power/index.js';

const IdentitySchema = z.object({
  locationId: z.string().describe('Stable identity assigned by input position'),
  label: z.string().describe('Verbatim caller label, possibly duplicated'),
  latitude: z.number().describe('Requested latitude in degrees north'),
  longitude: z.number().describe('Requested longitude in degrees east'),
});
const FailureSchema = IdentitySchema.extend({
  code: z.number().describe('Typed JSON-RPC error code'),
  reason: z.string().describe('Machine-readable failure reason'),
  message: z.string().describe('Failure explanation'),
  recovery: z.string().describe('Actionable next step'),
});
const BucketSchema = z.object({
  parameter: z.string().describe('Numeric parameter code'),
  locationId: z.string().describe('Stable input-position location identity'),
  units: z.string().optional().describe('Exact source units'),
  bucket: z
    .enum(['annual', 'DJF', 'MAM', 'JJA', 'SON'])
    .describe('Calendar bucket independent of hemisphere'),
  year: z.number().nullable().describe('Calendar or DJF ending year; null for climatology'),
  method: z
    .enum(['observation_mean', 'monthly_mean', 'source_annual', 'climatology_month_mean'])
    .describe('Exact aggregation method'),
  includedPeriods: z.number().describe('Valid numeric observations included'),
  returnedPeriods: z.number().describe('Returned union keys in the bucket'),
  expectedPeriods: z.number().describe('Full-calendar expected observation count'),
  complete: z.boolean().describe('Whether included count equals expected count'),
  windowClipped: z.boolean().describe('Whether the request cuts this calendar bucket'),
  mean: z.number().nullable().describe('Valid-only arithmetic mean, null without valid values'),
});
const LocationSchema = IdentitySchema.extend(PowerDatasetSchema.omit({ rows: true }).shape).extend({
  summaryCount: z
    .number()
    .int()
    .optional()
    .describe('Exact number of summaries for this location when summaries are previews'),
  sortMetric: z
    .number()
    .nullable()
    .describe('Valid numeric metric used for the requested sort, otherwise null'),
});
/** Full per-site provenance survives analytical staging. */
export const ComparisonOutputSchema = z.object({
  request: NormalizedCompareRequestSchema.describe(
    'Normalized shared request and the compared locations in input order',
  ),
  metadata: z
    .object({
      fetchedAt: z.string().describe('Comparison assembly access time'),
      endpointUrls: z
        .array(z.string().describe('Exact successful NASA endpoint'))
        .describe('Successful source endpoints in returned location order'),
    })
    .describe('Comparison access information; per-site provenance is in locations'),
  parameters: PowerDatasetSchema.shape.parameters,
  locations: z
    .array(LocationSchema.describe('Successful location with complete scientific provenance'))
    .describe('Successful locations in input or explicit metric order'),
  failed: z
    .array(FailureSchema.describe('Failed or unscheduled location'))
    .describe('Operational failures of compared locations in input order'),
  partial: z.boolean().describe('Whether any compared location failed'),
  deferredLocations: z
    .array(ComparisonLocationSchema)
    .optional()
    .describe(
      'Input locations after the compared ones, exactly as sent and in input order, ready to send as locations in a second call; present only when locations were deferred',
    ),
  summaries: z
    .array(BucketSchema.describe('One valid-only annual or seasonal bucket'))
    .describe('Independent per-location calendar summaries'),
  comparable: z
    .boolean()
    .describe(
      'Whether every returned numeric metric has consistent known units across successful sites',
    ),
  sort: z
    .object({
      parameter: z.string().describe('Selected comparable numeric parameter'),
      direction: z.enum(['asc', 'desc']).describe('Numeric ordering direction'),
      criterion: z
        .enum(['observation_mean', 'annual_record_mean', 'source_ANN'])
        .describe('Explicit scientific sort criterion'),
      nulls: z.literal('last').describe('Missing metric ordering'),
      ties: z.literal('input_order').describe('Stable ordering for equal metrics'),
    })
    .nullable()
    .describe('Applied numeric sort; null preserves input order'),
  possibleSharedGridCell: z
    .array(
      z
        .object({
          parameters: z
            .array(z.string().describe('Numeric parameter code'))
            .describe('Numeric parameters, in response order, whose series match at these sites'),
          locations: z
            .array(z.string().describe('Location identity'))
            .describe('Two or more sites in input order'),
        })
        .describe(
          'Sites whose returned series match exactly, nulls included, for every listed parameter',
        ),
    )
    .describe(
      'Sites that likely read one grid cell for the listed parameters, so they are indistinguishable on them rather than equal results. Solar and meteorology use different grids. Covers only the sites in this response; a parameter with fewer than two distinct valid values in the window is not checked. Coordinates are not asserted grid centers',
    ),
  rows: z
    .array(ObservationRowSchema.describe('One original period with location identity'))
    .describe('Complete observations or bounded preview when staged'),
  rowCount: z.number().int().describe('Exact full merged observation count'),
  dataset: DatasetHandleSchema.nullable().describe('Full-table handle on overflow, otherwise null'),
  summaryDatasets: SummaryDatasetsSchema.optional().describe(
    'Full summary handles when summary arrays are bounded previews; summaryIndex restores original order',
  ),
});

/**
 * Sequential sites share references, pacing, attempts, decoded bytes and deadline. Only the first
 * `POWER_LIMITS.comparedLocations` inputs are compared (one fewer when that would leave a single one); the
 * rest return as `deferredLocations` with a notice, and admission, fetching, the request echo and
 * any inline split see only the compared sites.
 */
export function presentComparison(
  request: CompareRequest,
  canvasId: string | undefined,
  ctx: Context,
) {
  if (request.selection.mode === 'parameters')
    request.selection.parameters = [...new Set(request.selection.parameters)];
  if (request.windSurface === 'airport_ice' || request.windSurface === 'airport ice')
    request.windSurface = 'airportice';
  const { comparedLocations } = POWER_LIMITS;
  const count =
    request.locations.length === comparedLocations + 1 ? comparedLocations - 1 : comparedLocations;
  const compared = { ...request, locations: request.locations.slice(0, count) };
  const deferredLocations = request.locations.slice(count);
  const notice = deferredLocations.length
    ? `Input locations ${count + 1}–${request.locations.length} were not compared: one call compares at most ${comparedLocations} and leaves at least two for the next. Send deferredLocations as locations in a second call with every other argument unchanged, and pass the canvas_id this response returned, if any, to keep both calls' tables on one canvas. That call numbers its sites from location_1, so match sites across calls by label; sort order and possibleSharedGridCell cover only one call's sites.`
    : undefined;
  const canvas = getCanvasService();
  return canvas.withProducer(estimateComparisonBytes(compared), ctx, async (producerCtx, lease) => {
    const power = getPowerService();
    const budget = power.createCallBudget(producerCtx, true, {
      deadlineMs: lease.remainingMs(),
      onHeldBytes: lease.bodyBytes,
    });
    const callCtx = { ...producerCtx, signal: budget.signal };
    const { locations: inputs, sort, ...shared } = compared;
    const first = inputs[0];
    if (!first) throw new Error('Validated comparison has no locations');
    const pointRequest = (location: { latitude: number; longitude: number }): PowerRequest => ({
      ...shared,
      latitude: location.latitude,
      longitude: location.longitude,
    });
    await power.validateRequest(pointRequest(first), callCtx, budget);
    if (sort && !requestedParameters(pointRequest(first)).includes(sort.parameter))
      throw powerError(
        'unsupported_parameter',
        'Sort parameter must be selected in the scientific request.',
      );
    const rows: ObservationRow[] = [];
    const locations: z.infer<typeof LocationSchema>[] = [];
    const failed: z.infer<typeof FailureSchema>[] = [];
    const summaries: z.infer<typeof BucketSchema>[] = [];
    const parameters = new Map<string, ParameterMetadata>();
    const units = new Map<string, Set<string | undefined>>();
    /** Per numeric parameter: series fingerprint → matching sites in input order. */
    const matches = new Map<string, Map<string, string[]>>();
    let rowBytes = 2;
    let stopped: McpError | undefined;
    for (const [index, location] of inputs.entries()) {
      callCtx.signal.throwIfAborted();
      const identity = { locationId: `location_${index + 1}`, ...location };
      let dataset: PowerDataset;
      try {
        if (stopped) throw stopped;
        dataset = await power.point(pointRequest(location), callCtx, budget);
      } catch (error) {
        callCtx.signal.throwIfAborted();
        if (!(error instanceof McpError)) throw error;
        if (error.data?.reason === 'dataset_limit') throw error;
        if (error.code === JsonRpcErrorCode.RequestCancelled) throw error;
        if (
          error.code === JsonRpcErrorCode.RateLimited &&
          error.data?.reason === 'upstream_rate_limited'
        )
          stopped = error;
        const recovery = error.data?.recovery;
        failed.push({
          ...identity,
          code: error.code,
          reason: typeof error.data?.reason === 'string' ? error.data.reason : 'upstream_failure',
          message: error.message,
          recovery:
            recovery &&
            typeof recovery === 'object' &&
            'hint' in recovery &&
            typeof recovery.hint === 'string'
              ? recovery.hint
              : 'Retry this location with nasa_power_compare_locations after checking nasa_power_list_reference coverage.',
        });
        continue;
      }
      for (const parameter of dataset.parameters) {
        parameters.set(parameter.code, parameter);
        if (parameter.valueKind === 'number') {
          const seen = units.get(parameter.code) ?? new Set<string | undefined>();
          seen.add(parameter.units);
          units.set(parameter.code, seen);
        }
      }
      if (parameters.size > POWER_LIMITS.columns)
        throw powerError('dataset_limit', 'Merged comparison exceeds the scientific column bound.');
      for (const row of dataset.rows) {
        callCtx.signal.throwIfAborted();
        const tagged = { ...row, locationId: identity.locationId, label: identity.label };
        rowBytes += Buffer.byteLength(JSON.stringify(tagged)) + (rows.length ? 1 : 0);
        if (rows.length >= POWER_LIMITS.rows || rowBytes > POWER_LIMITS.rowBytes)
          throw powerError(
            'dataset_limit',
            'Complete merged comparison exceeds normalized dataset bounds.',
          );
        rows.push(tagged);
      }
      lease.rowBytes(rowBytes);
      summaries.push(...summarizeBuckets(dataset, identity.locationId));
      /**
       * A site's series for one numeric parameter (units, period keys, values with fill as null)
       * is its fingerprint for that parameter. Elevation is left out: it names only the meteorology
       * cell. A series with fewer than two distinct valid values carries no cell identity.
       */
      const periods = createHash('sha256')
        .update(dataset.rows.map((row) => row.periodKey).join('\n'))
        .digest('hex');
      for (const parameter of dataset.parameters) {
        if (parameter.valueKind !== 'number') continue;
        callCtx.signal.throwIfAborted();
        const values = dataset.rows.map((row) => row[parameter.code]);
        const reference = values.find((value) => value !== null);
        if (!values.some((value) => value !== null && value !== reference)) continue;
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([parameter.units ?? null, periods]))
          .update(values.join(','))
          .digest('hex');
        const classes = matches.get(parameter.code) ?? new Map<string, string[]>();
        classes.set(fingerprint, [...(classes.get(fingerprint) ?? []), identity.locationId]);
        matches.set(parameter.code, classes);
      }
      const metric = sort
        ? dataset.summaries.filter(
            (summary) =>
              summary.parameter === sort.parameter &&
              (request.temporalResolution === 'monthly'
                ? summary.periodKind === 'annual'
                : request.temporalResolution === 'climatology'
                  ? summary.periodKind === 'climatology_annual'
                  : summary.periodKind ===
                    (request.temporalResolution === 'hourly' ? 'hour' : 'day')),
          )
        : [];
      const count = metric.reduce((sum, item) => sum + item.validCount, 0);
      const sortMetric = count
        ? metric.reduce((sum, item) => sum + (item.mean ?? 0) * item.validCount, 0) / count
        : null;
      const { rows: _rows, ...envelope } = dataset;
      locations.push({ ...identity, ...envelope, sortMetric });
    }
    if (!locations.length)
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        describePowerError('Every requested NASA POWER location failed.', { failed }),
        {
          reason: 'all_locations_failed',
          failed,
          recovery: {
            hint: 'Inspect each location failure and retry corrected locations with nasa_power_compare_locations.',
          },
        },
      );
    const comparableMetric = (code: string) => {
      const seen = units.get(code);
      return (
        seen?.size === 1 &&
        !seen.has(undefined) &&
        locations.every((location) =>
          location.parameters.some(
            (parameter) => parameter.code === code && parameter.valueKind === 'number',
          ),
        )
      );
    };
    if (sort && !comparableMetric(sort.parameter))
      throw powerError(
        'unsupported_parameter',
        'Requested sort requires a selected numeric parameter with identical known units at every successful location.',
      );
    if (sort)
      locations.sort((a, b) =>
        a.sortMetric === null
          ? b.sortMetric === null
            ? 0
            : 1
          : b.sortMetric === null
            ? -1
            : (sort.direction === 'asc' ? 1 : -1) * (a.sortMetric - b.sortMetric),
      );
    callCtx.signal.throwIfAborted();
    const output = await canvas.presentComparison(
      {
        request: compared,
        metadata: {
          fetchedAt: new Date().toISOString(),
          endpointUrls: locations.map((location) => location.metadata.endpointUrl),
        },
        parameters: [...parameters.values()].map((parameter) => {
          const { units: _units, ...rest } = parameter;
          const sharedUnits =
            parameter.units !== undefined &&
            locations.every((location) =>
              location.parameters.some(
                (candidate) =>
                  candidate.code === parameter.code && candidate.units === parameter.units,
              ),
            );
          return sharedUnits ? parameter : rest;
        }),
        locations,
        failed,
        partial: failed.length > 0,
        ...(deferredLocations.length ? { deferredLocations } : {}),
        summaries,
        comparable: [...units.keys()].every(comparableMetric),
        sort: sort
          ? {
              ...sort,
              criterion:
                request.temporalResolution === 'monthly'
                  ? ('annual_record_mean' as const)
                  : request.temporalResolution === 'climatology'
                    ? ('source_ANN' as const)
                    : ('observation_mean' as const),
              nulls: 'last' as const,
              ties: 'input_order' as const,
            }
          : null,
        possibleSharedGridCell: sharedGridCells(
          [...matches].flatMap(([parameter, classes]) =>
            [...classes.values()].map((locations) => ({ parameter, locations })),
          ),
          [...parameters.keys()],
          inputs.map((_, index) => `location_${index + 1}`),
        ),
        rows,
      },
      canvasId,
      callCtx,
      'nasa_power_compare_locations',
      lease,
      notice,
    );
    if (notice) ctx.enrich.notice(notice);
    return output;
  });
}
