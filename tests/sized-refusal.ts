/** @fileoverview Asserts a sized `canvas_required` refusal on both response surfaces. @module tests/sized-refusal */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import { markdownText } from './markdown-text.js';

type WireResult = Awaited<ReturnType<typeof runToolContract>>;
/** Refusal data a producing tool attaches when the complete result needs a canvas. */
export type SizedRefusal = {
  rowCount: number;
  inlineRows: number;
  calls: Record<string, unknown>[];
};

/**
 * A `canvas_required` refusal carrying the row count, the inline capacity and a multi-call split
 * in `error.data` and, call for call, in `content[]` with the sized recovery: each call is one
 * line holding every field it changes as JSON.
 */
export function sizedRefusal(result: WireResult, rowCount: number): SizedRefusal {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: { data: SizedRefusal & { reason: string; recovery: { hint: string } } };
  };
  expect(error.data.reason).toBe('canvas_required');
  expect(error.data.rowCount).toBe(rowCount);
  expect(error.data.inlineRows).toBeGreaterThan(0);
  /** A parameter-group split carries every row per call; a window or site split fewer. */
  expect(error.data.inlineRows).toBeLessThanOrEqual(rowCount);
  expect(error.data.calls.length).toBeGreaterThan(1);
  expect(error.data.recovery.hint).toContain(
    `The complete result has ${rowCount} rows and at most ${error.data.inlineRows} fit inline in one call. Re-send it as the ${error.data.calls.length} calls listed in calls`,
  );
  const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  const rendered = markdownText(text.join('\n'));
  for (const line of [
    'canvas_required',
    error.data.recovery.hint,
    `rowCount: ${rowCount}\n`,
    `inlineRows: ${error.data.inlineRows}\n`,
  ])
    expect(rendered).toContain(line);
  const lines = rendered.split('\n').filter((line) => line.startsWith('calls'));
  expect(lines).toEqual(
    error.data.calls.map((call, index) => `calls[${index}]: ${JSON.stringify(call)}`),
  );
  return { rowCount, inlineRows: error.data.inlineRows, calls: error.data.calls };
}
