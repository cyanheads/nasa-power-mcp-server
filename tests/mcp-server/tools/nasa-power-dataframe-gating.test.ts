/** @fileoverview Definition-time removal gate. @module tests/mcp-server/tools/nasa-power-dataframe-gating */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('dataframe drop registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it.each([
    ['false', true],
    ['true', false],
  ])('honors explicit enablement %s', async (value, disabled) => {
    vi.stubEnv('NASA_POWER_DATAFRAME_DROP_ENABLED', value);
    vi.resetModules();
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/nasa-power-dataframe-drop.tool.js'
    );
    expect(Boolean(Reflect.get(dataframeDropTool, '__mcpDisabled'))).toBe(disabled);
    if (disabled)
      expect(Reflect.get(dataframeDropTool, '__mcpDisabled')).toMatchObject({
        hint: 'NASA_POWER_DATAFRAME_DROP_ENABLED=true',
      });
  });
});
