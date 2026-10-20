/** @fileoverview Retrieve complete native-grid regional data. @module mcp-server/tools/definitions/nasa-power-get-region.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import { getCanvasService } from '@/services/canvas/index.js';
import {
  DatasetHandleSchema,
  getPowerService,
  RegionalDatasetSchema,
  RegionRequestSchema,
} from '@/services/power/index.js';

/** Retrieve one parameter across the complete returned native grid. */
export const getRegionTool = tool('nasa_power_get_region', {
  title: 'Get NASA POWER region',
  description:
    'Retrieve one parameter over ordered latitude/longitude bounds spanning 2–10 degrees per axis, at daily, monthly or climatology resolution. Split antimeridian regions into separate calls. Returns cell identities and separate per-period equal-weight cell statistics, not area-weighted estimates. Oversized results stage every row with a preview and canvas handle.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.discriminatedUnion('temporalResolution', [
    RegionRequestSchema.options[0].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
    RegionRequestSchema.options[1].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
    RegionRequestSchema.options[2].extend({
      canvas_id: CanvasIdSchema.optional().describe('Reuse an explicit canvas token for staging'),
    }),
  ]),
  output: RegionalDatasetSchema.extend({
    rowCount: z.number().int().describe('Exact full normalized observation count'),
    dataset: DatasetHandleSchema.nullable().describe(
      'Full-table handle on overflow, otherwise null',
    ),
  }),
  errors: [
    {
      reason: 'unsupported_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A selected code is unavailable for the community and resolution',
      recovery:
        'Use nasa_power_search_parameters with the same community and temporalResolution to choose supported parameter codes.',
      thrownBy: 'service',
    },
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
      when: 'Oversized observations require an enabled workspace',
      recovery:
        'Narrow the request for inline output, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb.',
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
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Producer or staging admission capacity is exhausted',
      recovery:
        'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Regional axes are reversed or span outside 2–10 degrees',
      recovery:
        'Send ordered bounds spanning 2 to 10 degrees per axis; split antimeridian regions into separate calls.',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The complete native-grid dataset exceeds workload bounds',
      recovery:
        'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    const { canvas_id, ...request } = input;
    const canvas = getCanvasService();
    return canvas.withProducer('single', ctx, async (producerCtx) => {
      const power = getPowerService();
      const budget = power.createCallBudget(producerCtx);
      const callCtx = { ...producerCtx, signal: budget.signal };
      return canvas.present(
        await power.region(request, callCtx, budget),
        canvas_id,
        callCtx,
        'nasa_power_get_region',
      );
    });
  },
  format: formatFaithfully,
});
