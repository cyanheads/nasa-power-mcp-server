/** @fileoverview Shared point output and source presentation. @module mcp-server/tools/definitions/point-contracts */
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { getCanvasService } from '@/services/canvas/index.js';
import { pointSplit } from '@/services/canvas/inline-split.js';
import { estimatePointBytes } from '@/services/canvas/producer-estimate.js';
import {
  DatasetHandleSchema,
  getPowerService,
  PowerDatasetSchema,
  type PowerRequest,
} from '@/services/power/index.js';

/** Full scientific envelope with exact row count and optional staged pointer. */
export const PointOutputSchema = PowerDatasetSchema.extend({
  rowCount: z.number().int().describe('Exact full normalized observation count'),
  dataset: DatasetHandleSchema.nullable().describe(
    'Full-table handle when observations exceed inline budget; null otherwise',
  ),
});

/** Source retrieval and presentation share one producer reservation and the deadline started at tool entry. */
export function presentPoint(
  request: PowerRequest,
  canvasId: string | undefined,
  ctx: Context,
  sourceTool: string,
) {
  const canvas = getCanvasService();
  return canvas.withProducer(estimatePointBytes(request), ctx, async (producerCtx, lease) => {
    const power = getPowerService();
    const budget = power.createCallBudget(producerCtx, false, {
      deadlineMs: lease.remainingMs(),
      onHeldBytes: lease.bodyBytes,
    });
    const callCtx = { ...producerCtx, signal: budget.signal };
    const dataset = await power.point(request, callCtx, budget);
    return canvas.present(dataset, canvasId, callCtx, sourceTool, {
      lease,
      split: pointSplit(dataset),
    });
  });
}
