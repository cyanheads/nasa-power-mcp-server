/** @fileoverview Shared point output and source presentation. @module mcp-server/tools/definitions/point-contracts */
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { POWER_LIMITS } from '@/config/server-config.js';
import { getCanvasService } from '@/services/canvas/index.js';
import {
  DatasetHandleSchema,
  getPowerService,
  PowerDatasetSchema,
  type PowerRequest,
  powerError,
} from '@/services/power/index.js';

/** Full scientific envelope with exact row count and optional staged pointer. */
export const PointOutputSchema = PowerDatasetSchema.extend({
  rowCount: z.number().int().describe('Exact full normalized observation count'),
  dataset: DatasetHandleSchema.nullable().describe(
    'Full-table handle when observations exceed inline budget; null otherwise',
  ),
});

/** Source retrieval and presentation share one producer reservation and deadline signal. */
export function presentPoint(
  request: PowerRequest,
  canvasId: string | undefined,
  ctx: Context,
  sourceTool: string,
) {
  return getCanvasService().withProducer('single', ctx, async (producerCtx) => {
    const power = getPowerService();
    const budget = power.createCallBudget(producerCtx);
    const callCtx = { ...producerCtx, signal: budget.signal };
    const dataset = await power.point(request, callCtx, budget);
    if (
      request.temporalResolution === 'climatology' &&
      JSON.stringify(dataset.rows).length > POWER_LIMITS.inlineCharacters
    )
      throw powerError(
        'dataset_limit',
        'Point climatology exceeds the complete inline profile budget.',
      );
    return getCanvasService().present(dataset, canvasId, callCtx, sourceTool);
  });
}
