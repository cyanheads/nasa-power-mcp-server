/** @fileoverview Endpoint-specific body-size recoveries at the HTTP boundary. @module tests/mcp-server/tools/nasa-power-reference-size-recovery */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { getTimeseriesTool } from '@/mcp-server/tools/definitions/nasa-power-get-timeseries.tool.js';
import { searchParametersTool } from '@/mcp-server/tools/definitions/nasa-power-search-parameters.tool.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';

let source: ReturnType<typeof initPowerService>;
let canvas: ReturnType<typeof initCanvasService>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  canvas = initCanvasService({
    storage: createInMemoryStorage(),
    config: { dataframeDropEnabled: false },
  });
});
afterEach(async () => {
  source.dispose();
  await canvas.shutdown();
  vi.useRealTimers();
});

it.each(['dictionary', 'configuration', 'observations'] as const)(
  'returns actionable recovery for oversized %s without relaxing the body cap',
  async (endpoint) => {
    const padding = 'x'.repeat(POWER_LIMITS.bodyBytes + 1);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/parameters'))
        return Response.json({
          T2M: { definition: endpoint === 'dictionary' ? padding : 'Temperature' },
        });
      if (url.pathname.endsWith('/configuration'))
        return Response.json({
          settings: { start: '1981-01-01' },
          documentation: { description: endpoint === 'configuration' ? padding : 'Coverage' },
        });
      return Response.json({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122, 47] },
        properties: { parameter: { T2M: { '20240101': 3 } } },
        padding,
      });
    });
    source = initPowerService({ fetch: fetcher, config: { dataframeDropEnabled: false } });
    const pending =
      endpoint === 'dictionary'
        ? runToolContract(searchParametersTool, { filter: 'T2M', limit: 1 })
        : runToolContract(getTimeseriesTool, {
            latitude: 47,
            longitude: -122,
            startDate: '2024-01-01',
            endDate: '2024-01-01',
            selection: { mode: 'parameters', parameters: ['T2M'] },
          });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'dataset_limit', recovery: { hint: expect.any(String) } },
      },
    });
    const { error } = result.structuredContent as {
      error: { data: { recovery: { hint: string } } };
    };
    const hint = error.data.recovery.hint;
    const rendered = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(rendered).toContain(hint);
    expect(rendered).toContain('dataset_limit');
    expect(fetcher).toHaveBeenCalledTimes(
      endpoint === 'dictionary' ? 1 : endpoint === 'configuration' ? 2 : 3,
    );
    if (endpoint === 'observations') {
      expect(hint).toMatch(/narrow.*date window/i);
    } else {
      expect(hint).toMatch(/retry/i);
      expect(hint).toMatch(/report/i);
      expect(hint).toMatch(/reference|dictionary|configuration/i);
      expect(hint).not.toMatch(
        /narrow.*(?:date window|region|selected parameters|location count)|(?:reduce|shrink|narrow).*(?:filter|page|limit)/i,
      );
      if (endpoint === 'dictionary') {
        const declared = searchParametersTool.errors?.find(
          (entry) => entry.reason === 'dataset_limit',
        );
        expect(declared?.recovery).toBe(hint);
      }
    }
  },
);
