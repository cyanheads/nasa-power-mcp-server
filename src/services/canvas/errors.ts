/** @fileoverview Safe workspace failures and public recovery instructions. @module services/canvas/errors */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

const serviceErrors = new WeakSet<McpError>();
/** Native messages already redact configured directories. Scan at most 2,048 characters. */
function diagnostic(error: McpError): string {
  const bounded = error.message.slice(0, 2048);
  const end = bounded.search(/[\r\n]/);
  const line = end === -1 ? bounded : bounded.slice(0, end);
  return line
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\/|\\\\)[^"'\r\n]*\1/g, '$1[path]$1')
    .replace(/(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s"'<>]*/g, '[path]')
    .slice(0, 1024);
}
const definitions = {
  canvas_required: [
    JsonRpcErrorCode.ConfigurationError,
    'Narrow the request for inline output, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb.',
  ],
  canvas_unavailable: [
    JsonRpcErrorCode.ConfigurationError,
    'Use the npm or Docker distribution with DuckDB installed and CANVAS_PROVIDER_TYPE=duckdb, or request a smaller inline dataset.',
  ],
  canvas_not_found: [
    JsonRpcErrorCode.NotFound,
    'Check canvas_id against the producing response, or rerun the producing tool to stage a fresh dataset.',
  ],
  canvas_capacity_exhausted: [
    JsonRpcErrorCode.RateLimited,
    'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
  ],
  missing_table: [
    JsonRpcErrorCode.NotFound,
    'Use nasa_power_dataframe_describe with the same canvas_id to inspect active tables, or rerun the producing tool.',
  ],
  query_limit: [
    JsonRpcErrorCode.ValidationError,
    'Reduce SQL length or narrow the SELECT projection and row limit, then retry nasa_power_dataframe_query.',
  ],
} as const;
/** Create a classified failure without engine paths or private context. */
export function canvasError(
  reason: keyof typeof definitions,
  message: string,
  recovery?: string,
): McpError {
  const [code, hint] = definitions[reason];
  const error = new McpError(code, message, {
    reason,
    recovery: { hint: recovery ?? hint },
    ...(reason === 'canvas_capacity_exhausted' ? { retryable: true } : {}),
  });
  serviceErrors.add(error);
  return error;
}
/** Preserve native error classification while bounding caller diagnostics. */
export function safeCanvasError(error: unknown, drop = false): never {
  if (!(error instanceof McpError)) throw error;
  if (serviceErrors.has(error)) throw error;
  const reason = error.data?.reason;
  if (reason === 'canvas_not_found')
    throw canvasError(
      'canvas_not_found',
      'Canvas not found or expired.',
      drop ? 'The canvas has expired or is absent; there is nothing left to remove.' : undefined,
    );
  if (reason === 'canvas_capacity_exhausted')
    throw canvasError(reason, 'Analytical workspace capacity is exhausted.');
  if (reason === 'missing_table') throw canvasError(reason, diagnostic(error));
  if (reason === 'invalid_sql' || reason === 'sql_parse_error')
    throw new McpError(JsonRpcErrorCode.ValidationError, diagnostic(error), {
      reason: 'invalid_sql',
      recovery: {
        hint: 'Check SQL syntax and column names against nasa_power_dataframe_describe using the same canvas_id.',
      },
    });
  if (reason === 'sql_execution_error')
    throw new McpError(error.code, diagnostic(error), {
      reason,
      recovery: {
        hint: 'Use TRY_CAST or filter the offending values before converting them, then retry the SELECT.',
      },
    });
  if (
    typeof reason === 'string' &&
    [
      'non_select_statement',
      'multi_statement',
      'denied_function',
      'system_catalog_access',
      'sql_read_only',
      'plan_operator_not_allowed',
    ].includes(reason)
  )
    throw new McpError(
      error.code,
      reason === 'denied_function'
        ? diagnostic(error)
        : 'The statement is outside the read-only analytical surface.',
      {
        reason,
        recovery: {
          hint: 'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
        },
      },
    );
  throw new McpError(
    error.code,
    'The analytical engine could not complete this operation.',
    reason === 'cancelled' ? { reason } : undefined,
  );
}
