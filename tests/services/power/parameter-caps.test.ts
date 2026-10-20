/** @fileoverview Resolution-specific parameter caps and correction recovery. @module tests/services/power/parameter-caps */
import { z } from '@cyanheads/mcp-ts-core';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLocationsTool } from '@/mcp-server/tools/definitions/nasa-power-compare-locations.tool.js';
import { getTimeseriesTool } from '@/mcp-server/tools/definitions/nasa-power-get-timeseries.tool.js';
import { initCanvasService } from '@/services/canvas/index.js';
import {
  initPowerService,
  PowerRequestSchema,
  requestedParameters,
} from '@/services/power/index.js';

const codes = (count: number) => Array.from({ length: count }, (_, index) => `P${index}`);
const locations = [
  { label: 'one', latitude: 0, longitude: 0 },
  { label: 'two', latitude: 1, longitude: 1 },
];
const input = (parameters: string[], extra = {}) => ({
  temporalResolution: 'hourly' as const,
  startDate: '2024-01-01',
  endDate: '2024-01-01',
  latitude: 0,
  longitude: 0,
  selection: { mode: 'parameters' as const, parameters },
  ...extra,
});
let source: ReturnType<typeof initPowerService>;
let canvas: ReturnType<typeof initCanvasService>;
const fetcher = vi.fn<typeof fetch>(async () => {
  throw new Error('Overflow must fail before HTTP');
});

describe('published and effective parameter caps', () => {
  beforeEach(() => {
    fetcher.mockClear();
    source = initPowerService({ fetch: fetcher, config: { dataframeDropEnabled: false } });
    canvas = initCanvasService({
      storage: createInMemoryStorage(),
      config: { dataframeDropEnabled: false },
    });
  });
  afterEach(async () => {
    source.dispose();
    await canvas.shutdown();
  });

  it.each([getTimeseriesTool, compareLocationsTool])(
    '$name advertises hourly15 and daily/monthly20 in actual JSON Schema',
    (definition) => {
      const schema = z.toJSONSchema(definition.input);
      const serialized = JSON.stringify(schema);
      const document: {
        oneOf: {
          properties: {
            temporalResolution: { const: string };
            selection: { oneOf: { properties: { parameters?: { maxItems: number } } }[] };
          };
        }[];
      } = JSON.parse(serialized);
      for (const [resolution, maximum] of [
        ['hourly', 15],
        ['daily', 20],
        ['monthly', 20],
      ] as const) {
        const branch = document.oneOf.find(
          (item) => item.properties.temporalResolution.const === resolution,
        );
        const explicit = branch?.properties.selection.oneOf.find(
          (item) => item.properties.parameters,
        );
        expect(explicit?.properties.parameters?.maxItems, resolution).toBe(maximum);
      }
    },
  );

  it('accepts fifteen hourly codes and rejects sixteen at the public schema', () => {
    expect(getTimeseriesTool.input.safeParse(input(codes(15))).success).toBe(true);
    expect(getTimeseriesTool.input.safeParse(input(codes(16))).success).toBe(false);
    const { latitude: _lat, longitude: _lon, ...shared } = input(codes(16));
    expect(compareLocationsTool.input.safeParse({ ...shared, locations }).success).toBe(false);
  });

  it.each(['point', 'comparison'] as const)(
    'reports effective correction overflow on both %s error surfaces before HTTP',
    async (kind) => {
      const args = input(codes(15), { siteElevation: 0 });
      const { latitude: _lat, longitude: _lon, ...shared } = args;
      const result =
        kind === 'point'
          ? await runToolContract(getTimeseriesTool, args)
          : await runToolContract(compareLocationsTool, { ...shared, locations });
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'unsupported_parameter', count: 16, limit: 15 } },
      });
      const structured = result.structuredContent as {
        error: { message: string; data: { recovery: { hint: string } } };
      };
      expect(structured.error.data.recovery.hint).toMatch(/reduce|remove|fewer|at most/i);
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('16');
      expect(text).toContain('15');
      expect(text).toContain(structured.error.data.recovery.hint);
    },
  );

  it('counts explicitly selected PSC/WSC only once and retains corrected daily20', () => {
    const hourly = PowerRequestSchema.parse(
      input([...codes(13), 'PSC', 'WSC'], {
        siteElevation: 0,
        windElevation: 50,
        windSurface: 'grass',
      }),
    );
    expect(requestedParameters(hourly)).toHaveLength(15);
    expect(requestedParameters(hourly).filter((code) => code === 'PSC')).toHaveLength(1);
    expect(requestedParameters(hourly).filter((code) => code === 'WSC')).toHaveLength(1);
    const daily = PowerRequestSchema.parse(
      input([...codes(18), 'PSC', 'WSC'], {
        temporalResolution: 'daily',
        siteElevation: 0,
        windElevation: 50,
        windSurface: 'grass',
      }),
    );
    expect(requestedParameters(daily)).toHaveLength(20);
    expect(getTimeseriesTool.input.safeParse(daily).success).toBe(true);
  });
});
