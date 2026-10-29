/** @fileoverview Compare bounded POWER observations across locations. @module mcp-server/tools/definitions/nasa-power-compare-locations.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import { CompareRequestSchema } from '@/services/power/index.js';
import { ComparisonOutputSchema, presentComparison } from './comparison-contracts.js';

/** Compare sites without inventing scientific rankings or unit conversions. */
export const compareLocationsTool = tool('nasa_power_compare_locations', {
  title: 'Compare NASA POWER locations',
  description:
    'Compare 2–10 labeled coordinates with a shared parameter selection and window; climatology is the default resolution. Duplicate labels retain separate input-position identities. Returns per-site provenance and valid-only annual/seasonal summaries; operational site failures preserve successes. Optional numeric sort uses observation means, monthly annual records or climatology ANN, with nulls last and stable ties; differing or unknown units cannot sort. Oversized observations and summaries stage completely; summaryDatasets handles and summaryIndex preserve complete ordered summary arrays.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.discriminatedUnion('temporalResolution', [
    CompareRequestSchema.options[0].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
    CompareRequestSchema.options[1].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
    CompareRequestSchema.options[2].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
    CompareRequestSchema.options[3].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
  ]),
  output: ComparisonOutputSchema,
  errors: [
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested window is reversed or outside source coverage',
      recovery:
        'Use nasa_power_list_reference topic coverage and send an ordered window within the supported period.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_correction',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Correction inputs are unsupported or missing required dependencies',
      recovery:
        'Use nasa_power_list_reference topic wind_surfaces and supply both windElevation and windSurface for corrected wind speed.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NASA rejects the scientific request or reference lookup',
      recovery:
        'Inspect the returned NASA messages, then use nasa_power_list_reference topic coverage or nasa_power_search_parameters to revise the request.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NASA rate limits a request or shared reference lookup',
      recovery:
        'Wait for the reported retry delay before repeating this request; reuse an existing result when possible.',
      thrownBy: 'service',
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
      reason: 'canvas_required',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Oversized observations or summaries require an enabled workspace',
      recovery:
        'Re-send the request as the calls listed in the error, each sized to fit inline, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas token is absent or expired',
      recovery:
        'Check canvas_id against the producing response, or rerun the producing tool to stage a fresh dataset.',
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
      reason: 'unsupported_preset',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The selected preset is unavailable at this resolution',
      recovery:
        'Use nasa_power_list_reference topic presets to choose a preset supported at this temporal resolution.',
      thrownBy: 'service',
    },
    {
      reason: 'all_locations_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every requested location failed operationally',
      recovery:
        'Inspect each location failure and retry corrected locations with nasa_power_compare_locations.',
      thrownBy: 'service',
    },
    {
      reason: 'unsupported_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Selection or sort is unsupported or requested units are incomparable',
      recovery:
        'Use nasa_power_search_parameters with the same community and temporalResolution to choose supported parameter codes.',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The complete merged dataset exceeds workload bounds',
      recovery:
        'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    const { canvas_id, ...request } = input;
    return presentComparison(request, canvas_id, ctx);
  },
  format: formatFaithfully,
});
