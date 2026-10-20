/** @fileoverview Explicitly gated staged-table removal. @module mcp-server/tools/definitions/nasa-power-dataframe-drop.tool */
import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { getCanvasService } from '@/services/canvas/index.js';

const definition = tool('nasa_power_dataframe_drop', {
  title: 'Remove a staged POWER table',
  description:
    'Remove only the named table in the supplied canvas. An absent table returns dropped false while other tables keep the canvas alive. Removing the final table retires its token; later calls return canvas_not_found. Available only when explicit dataframe removal is enabled.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Canvas token returned by a producing POWER tool'),
    table: z.string().min(1).describe('Exact staged table name to remove'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Supplied canvas token'),
    table: z.string().describe('Supplied table name'),
    dropped: z.boolean().describe('Whether an existing table was removed'),
  }),
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
      recovery: 'The canvas has expired or is absent; there is nothing left to remove.',
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
  ],
  handler: (input, ctx) => getCanvasService().drop(input.canvas_id, { table: input.table }, ctx),
  format: formatFaithfully,
});
export const dataframeDropTool = getServerConfig().dataframeDropEnabled
  ? definition
  : disabledTool(definition, {
      reason: 'Explicit dataframe removal is disabled.',
      hint: 'NASA_POWER_DATAFRAME_DROP_ENABLED=true',
    });
