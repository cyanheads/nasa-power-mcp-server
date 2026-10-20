/** @fileoverview Bounded read-only SQL over staged POWER observations. @module mcp-server/tools/definitions/nasa-power-dataframe-query.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { POWER_LIMITS } from '@/config/server-config.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { getCanvasService, QueryResultSchema } from '@/services/canvas/index.js';

export const dataframeQueryTool = tool('nasa_power_dataframe_query', {
  title: 'Query staged POWER observations',
  description:
    'Run one read-only SELECT over tables in an explicitly supplied canvas_id. Inspect names and units with nasa_power_dataframe_describe. External files, imports, writes and system catalogs are refused. Returns at most 1,000 rows and 40,000 JSON characters; truncated rowCount counts only materialized rows.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Canvas token returned by a producing POWER tool'),
    sql: z
      .string()
      .min(1)
      .max(POWER_LIMITS.sqlCharacters)
      .describe('One read-only SELECT, at most 16,384 characters'),
    rowLimit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe('Positive maximum row count; values above 1,000 use an effective cap of 1,000'),
  }),
  output: QueryResultSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Effective output row cap when the requested limit is larger'),
  },
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Analytical workspace is disabled or native support is unavailable',
      recovery:
        'Use the npm or Docker distribution with DuckDB installed and CANVAS_PROVIDER_TYPE=duckdb, or request a smaller inline dataset.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Token is absent, expired or belongs to another tenant',
      recovery:
        'Check canvas_id against the producing response, or rerun the producing tool to stage a fresh dataset.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Canvas or process query capacity is exhausted',
      recovery:
        'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'SQL names an absent table',
      recovery:
        'Use nasa_power_dataframe_describe with the same canvas_id to inspect active tables, or rerun the producing tool.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL has invalid syntax or binding',
      recovery:
        'Check SQL syntax and column names against nasa_power_dataframe_describe using the same canvas_id.',
      thrownBy: 'service',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL conversion or evaluation fails',
      recovery:
        'Use TRY_CAST or filter the offending values before converting them, then retry the SELECT.',
      thrownBy: 'service',
    },
    {
      reason: 'non_select_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL is not a SELECT',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'multi_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL contains several statements',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'denied_function',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL invokes a denied function',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL accesses system catalogs',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'sql_read_only',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL reaches outside read-only staged data',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'plan_operator_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL plan uses an unavailable operator',
      recovery:
        'Send one read-only SELECT against tables shown by nasa_power_dataframe_describe; remove external data and system catalog access.',
      thrownBy: 'service',
    },
    {
      reason: 'query_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL length or projected values exceed the response budget',
      recovery:
        'Reduce SQL length or narrow the SELECT projection and row limit, then retry nasa_power_dataframe_query.',
      thrownBy: 'service',
    },
  ],
  handler: (input, ctx) =>
    getCanvasService().query(input.canvas_id, { sql: input.sql, rowLimit: input.rowLimit }, ctx),
  format: formatFaithfully,
});
