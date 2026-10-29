/** @fileoverview Retrieve complete point timeseries data. @module mcp-server/tools/definitions/nasa-power-get-timeseries.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import { PowerRequestSchema } from '@/services/power/index.js';
import { PointOutputSchema, presentPoint } from './point-contracts.js';
/** Retrieve source observations with complete scientific provenance. */
export const getTimeseriesTool = tool('nasa_power_get_timeseries', {
  title: 'Get NASA POWER timeseries',
  description:
    'Retrieve complete hourly, daily or monthly observations at latitude/longitude. Hourly and daily require startDate/endDate; monthly requires startYear/endYear. Use nasa_power_search_parameters for codes and nasa_power_list_reference for presets. Large results return a full-table canvas handle and preview.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.discriminatedUnion('temporalResolution', [
    PowerRequestSchema.options[0].extend({
      canvas_id: CanvasIdSchema.optional().describe(
        'Reuse a returned canvas token for an oversized result',
      ),
    }),
    PowerRequestSchema.options[1].extend({
      canvas_id: CanvasIdSchema.optional().describe(
        'Reuse a returned canvas token for an oversized result',
      ),
    }),
    PowerRequestSchema.options[2].extend({
      canvas_id: CanvasIdSchema.optional().describe(
        'Reuse a returned canvas token for an oversized result',
      ),
    }),
  ]),
  output: PointOutputSchema,
  errors: [
    {
      reason: 'unsupported_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Selected parameter is unavailable for this community and resolution',
      recovery:
        'Use nasa_power_search_parameters with the same community and temporalResolution to choose supported parameter codes.',
      thrownBy: 'service',
    },
    {
      reason: 'unsupported_preset',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Preset is unavailable at this resolution',
      recovery:
        'Use nasa_power_list_reference topic presets to choose a preset supported at this temporal resolution.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Window is reversed, impossible or outside source coverage',
      recovery:
        'Use nasa_power_list_reference topic coverage and send an ordered window within the supported period.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_correction',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Wind settings are unpaired or correction inputs are missing',
      recovery:
        'Use nasa_power_list_reference topic wind_surfaces and supply both windElevation and windSurface for corrected wind speed.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NASA rejects the scientific request',
      recovery:
        'Inspect the returned NASA messages, then use nasa_power_list_reference topic coverage or nasa_power_search_parameters to revise the request.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NASA responds with a rate limit',
      recovery:
        'Wait for the reported retry delay before repeating this request; reuse an existing result when possible.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'request_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Source scheduling capacity is exhausted',
      recovery: 'Wait for pending requests to finish, then retry a smaller request.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'dataset_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Complete data exceeds a bounded workload limit',
      recovery:
        'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
      thrownBy: 'service',
    },
    {
      reason: 'producer_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Other data calls hold the in-flight capacity this call needs past its admission wait',
      recovery:
        'Another data call is in flight and holds the capacity this call needs; retry when it returns.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Canvas count, table or retained staging capacity is exhausted',
      recovery:
        'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'canvas_busy',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Another query, staging or removal occupies the supplied canvas',
      recovery: 'A query or operation is already in flight; retry this call when it returns.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'canvas_required',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Oversized observations require an enabled workspace',
      recovery:
        'Re-send the request as the calls listed in the error, each sized to fit inline, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied workspace token is absent or expired',
      recovery:
        'Check canvas_id against the producing response, or rerun the producing tool to stage a fresh dataset.',
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    const { canvas_id, ...request } = input;
    return presentPoint(request, canvas_id, ctx, 'nasa_power_get_timeseries');
  },
  format: formatFaithfully,
});
