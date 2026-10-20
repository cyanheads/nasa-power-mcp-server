/** @fileoverview POWER classified failures and recoveries. @module services/power/errors */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** Reference bodies are fetched whole, independent of observation inputs or local pagination. */
export const REFERENCE_LIMIT_RECOVERY =
  'Retry later; if the reference response still exceeds the size limit, report it to the server maintainer. Local filters, pagination, and observation inputs cannot reduce this upstream reference response.';

/** Recoveries shared with the tool error contracts. */
export const RECOVERIES = {
  unsupported_parameter:
    'Use nasa_power_search_parameters with the same community and temporalResolution to choose supported parameter codes.',
  unsupported_preset:
    'Use nasa_power_list_reference topic presets to choose a preset supported at this temporal resolution.',
  invalid_window:
    'Use nasa_power_list_reference topic coverage and send an ordered window within the supported period.',
  invalid_region:
    'Send ordered bounds spanning 2 to 10 degrees per axis; split antimeridian regions into separate calls.',
  invalid_correction:
    'Use nasa_power_list_reference topic wind_surfaces and supply both windElevation and windSurface for corrected wind speed.',
  upstream_rejected:
    'Inspect the returned NASA messages, then use nasa_power_list_reference topic coverage or nasa_power_search_parameters to revise the request.',
  upstream_rate_limited:
    'Wait for the reported retry delay before repeating this request; reuse an existing result when possible.',
  request_queue_full: 'Wait for pending requests to finish, then retry a smaller request.',
  dataset_limit:
    'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
} as const;
/** Render client-actionable error data without flattening source strings or interpreting their markup. */
export function describePowerError(message: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const fence = '`'.repeat(
        Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)),
      );
      lines.push(`${path}:\n${fence}\n${value}\n${fence}`);
    } else if (Array.isArray(value)) {
      if (!value.length) lines.push(`${path}: []`);
      for (const [index, entry] of value.entries()) visit(entry, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) lines.push(`${path}: {}`);
      for (const [key, entry] of entries) visit(entry, `${path}.${key}`);
    } else if (value !== undefined) lines.push(`${path}: ${String(value)}`);
  };
  for (const [key, value] of Object.entries(data)) {
    if (!['reason', 'retryable', 'recovery', 'requestId'].includes(key)) visit(value, key);
  }
  return lines.length ? `${message}\n\n${lines.join('\n\n')}` : message;
}
/** Create an advertised service failure. */
export function powerError(
  reason: keyof typeof RECOVERIES,
  message: string,
  data: Record<string, unknown> = {},
): McpError {
  const limited = reason === 'upstream_rate_limited' || reason === 'request_queue_full';
  return new McpError(
    limited ? JsonRpcErrorCode.RateLimited : JsonRpcErrorCode.ValidationError,
    describePowerError(message, data),
    {
      reason,
      retryable: reason === 'request_queue_full',
      recovery: { hint: RECOVERIES[reason] },
      ...data,
    },
  );
}
/** Scientific shapes are deterministic failures and must never be retried. */
export function shapeError(message: string): McpError {
  return new McpError(JsonRpcErrorCode.SerializationError, message, { retryable: false });
}
