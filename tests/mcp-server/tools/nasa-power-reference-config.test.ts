/** @fileoverview Reference configuration matches runtime distribution choices. @module tests/mcp-server/tools/nasa-power-reference-config */
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetConfig();
});

it.each([
  ['none', 'false', false, false],
  ['duckdb', 'false', true, false],
  ['none', 'true', false, true],
  ['duckdb', 'true', true, true],
] as const)(
  'reports provider %s and drop %s on both paths',
  async (provider, drop, available, enabled) => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', provider);
    vi.stubEnv('NASA_POWER_DATAFRAME_DROP_ENABLED', drop);
    resetConfig();
    vi.resetModules();
    const { listReferenceTool } = await import(
      '@/mcp-server/tools/definitions/nasa-power-list-reference.tool.js'
    );
    const result = await runToolContract(listReferenceTool, { topic: 'dataframes' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      entries: [
        {
          available,
          dropEnabled: enabled,
          tableTtlInMs: 1_800_000,
          canvasTtlInMs: 3_600_000,
          absoluteLifetimeInMs: 21_600_000,
        },
      ],
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain('dropEnabled');
    expect(text.includes('Use nasa_power_dataframe_drop')).toBe(enabled);
  },
);
