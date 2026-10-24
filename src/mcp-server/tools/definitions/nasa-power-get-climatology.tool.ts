/** @fileoverview Retrieve complete point climatology data. @module mcp-server/tools/definitions/nasa-power-get-climatology.tool */
import { tool } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import { NormalizedClimatologyRequestSchema, PowerRequestSchema } from '@/services/power/index.js';
import { PointOutputSchema, presentPoint } from './point-contracts.js';
/** Retrieve source observations with complete scientific provenance. */
export const getClimatologyTool = tool('nasa_power_get_climatology', {
  title: 'Get NASA POWER climatology',
  description:
    'Retrieve complete monthly and annual climatology at latitude/longitude. Optionally supply both startYear and endYear; omitted years use the source product range. Use nasa_power_list_reference for presets and tilted solar aliases. Small profiles remain inline; larger profiles return a complete table handle and bounded preview, preserving orientation text. Supply canvas_id to reuse a returned workspace.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: PowerRequestSchema.options[3].omit({ temporalResolution: true }).extend({
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse a returned canvas token for an oversized profile',
    ),
  }),
  output: PointOutputSchema.extend({
    request: NormalizedClimatologyRequestSchema.describe(
      'Normalized climatology request and corrections',
    ),
  }),
  errors: [
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
      when: 'The supplied workspace token is absent or expired',
      recovery:
        'Check canvas_id against the producing response, or rerun the producing tool to stage a fresh dataset.',
      thrownBy: 'service',
    },
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
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Producer or staging admission capacity is exhausted',
      recovery:
        'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
      thrownBy: 'service',
      retryable: true,
    },
  ],
  async handler(input, ctx) {
    const { canvas_id, ...request } = input;
    const output = await presentPoint(
      { ...request, temporalResolution: 'climatology' },
      canvas_id,
      ctx,
      'nasa_power_get_climatology',
    );
    return {
      ...output,
      request: { ...output.request, temporalResolution: 'climatology' as const },
    };
  },
  format: formatFaithfully,
});
