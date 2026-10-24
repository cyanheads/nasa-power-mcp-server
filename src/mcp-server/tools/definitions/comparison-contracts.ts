/** @fileoverview Bounded comparison orchestration and scientific output. @module mcp-server/tools/definitions/comparison-contracts */
import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { POWER_LIMITS } from '@/config/server-config.js';
import { getCanvasService, SummaryDatasetsSchema } from '@/services/canvas/index.js';
import {
  type CompareRequest,
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
    'Normalized shared request and original location order',
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
    .describe('Operational failures in original input order'),
  partial: z.boolean().describe('Whether any requested location failed'),
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
        .array(z.string().describe('Location identity'))
        .describe('Locations with identical complete values and elevation'),
    )
    .describe('Possible shared-grid notice only; coordinates are not asserted grid centers'),
  rows: z
    .array(ObservationRowSchema.describe('One original period with location identity'))
    .describe('Complete observations or bounded preview when staged'),
  rowCount: z.number().int().describe('Exact full merged observation count'),
  dataset: DatasetHandleSchema.nullable().describe('Full-table handle on overflow, otherwise null'),
  summaryDatasets: SummaryDatasetsSchema.optional().describe(
    'Full summary handles when summary arrays are bounded previews; summaryIndex restores original order',
  ),
});

/** Sequential sites share references, pacing, attempts, decoded bytes and deadline. */
export function presentComparison(
  request: CompareRequest,
  canvasId: string | undefined,
  ctx: Context,
) {
  if (request.selection.mode === 'parameters')
    request.selection.parameters = [...new Set(request.selection.parameters)];
  if (request.windSurface === 'airport_ice' || request.windSurface === 'airport ice')
    request.windSurface = 'airportice';
  return getCanvasService().withProducer('comparison', ctx, async (producerCtx) => {
    const power = getPowerService();
    const budget = power.createCallBudget(producerCtx, true);
    const callCtx = { ...producerCtx, signal: budget.signal };
    const { locations: inputs, sort, ...shared } = request;
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
    const fingerprints = new Map<string, string[]>();
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
      summaries.push(...summarizeBuckets(dataset, identity.locationId));
      const numeric = dataset.parameters.filter((parameter) => parameter.valueKind === 'number');
      if (
        dataset.rows.length &&
        !dataset.omittedParameters.length &&
        numeric.length &&
        dataset.rows.every(
          (row) =>
            row.elevation !== null &&
            dataset.parameters.every(
              (parameter) => row[parameter.code] !== null && row[parameter.code] !== undefined,
            ),
        )
      ) {
        const hash = createHash('sha256');
        for (const row of dataset.rows) {
          callCtx.signal.throwIfAborted();
          hash.update(
            JSON.stringify([
              row.periodKey,
              row.periodKind,
              row.elevation,
              ...dataset.parameters.map((parameter) => [
                parameter.code,
                parameter.units,
                row[parameter.code],
              ]),
            ]),
          );
        }
        const fingerprint = hash.digest('hex');
        const matches = fingerprints.get(fingerprint) ?? [];
        matches.push(identity.locationId);
        fingerprints.set(fingerprint, matches);
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
    return getCanvasService().presentComparison(
      {
        request,
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
        possibleSharedGridCell: [...fingerprints.values()].filter((group) => group.length > 1),
        rows,
      },
      canvasId,
      callCtx,
      'nasa_power_compare_locations',
    );
  });
}
