/** @fileoverview Inspect explicit-token analytical tables. @module mcp-server/tools/definitions/nasa-power-dataframe-describe.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import { DescribeResultSchema, getCanvasService } from '@/services/canvas/index.js';

export const dataframeDescribeTool = tool('nasa_power_dataframe_describe', {
  title: 'Describe staged POWER tables',
  description:
    'Inspect table schemas, physical units and original scientific provenance within a canvas_id returned by a producing POWER tool. Tokens are process-local capabilities; only the supplied canvas is inspected.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Canvas token returned by a producing POWER tool'),
    table: z
      .string()
      .optional()
      .describe('One table name from a producing response; omit to inspect this canvas'),
  }),
  output: DescribeResultSchema,
  errors: [
    {
      reason: 'query_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Complete table provenance exceeds the structured or rendered response budget',
      recovery:
        'Specify one table with nasa_power_dataframe_describe, or narrow the request to the producing tool and stage a smaller dataset.',
      thrownBy: 'service',
    },
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
      when: 'Another operation occupies this canvas',
      recovery:
        'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The named table is absent',
      recovery:
        'Use nasa_power_dataframe_describe with the same canvas_id to inspect active tables, or rerun the producing tool.',
      thrownBy: 'service',
    },
  ],
  handler: (input, ctx) =>
    getCanvasService().describe(input.canvas_id, input.table ? { table: input.table } : {}, ctx),
  format: formatFaithfully,
});
