/** @fileoverview Startup configuration at the real Node process boundary. @module tests/config/server-config */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const configUrl = new URL('../../src/config/server-config.ts', import.meta.url).href;

function readConfig(envFile?: string, exportedValue?: string): unknown {
  const cwd = mkdtempSync(join(tmpdir(), 'nasa-power-config-'));
  try {
    if (envFile !== undefined) writeFileSync(join(cwd, '.env'), envFile);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(exportedValue === undefined ? {} : { NASA_POWER_DATAFRAME_DROP_ENABLED: exportedValue }),
    };
    const child = spawnSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `const { getServerConfig } = await import(${JSON.stringify(configUrl)}); process.stdout.write(JSON.stringify(getServerConfig()));`,
      ],
      { cwd, env, encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('server configuration before application startup', () => {
  it('reads the working-directory .env on the first configuration access', () => {
    expect(readConfig('NASA_POWER_DATAFRAME_DROP_ENABLED=true\n')).toEqual({
      dataframeDropEnabled: true,
    });
  });

  it('preserves explicitly exported false over a true .env value', () => {
    expect(readConfig('NASA_POWER_DATAFRAME_DROP_ENABLED=true\n', 'false')).toEqual({
      dataframeDropEnabled: false,
    });
  });

  it('defaults dataframe removal to false when the environment and .env are absent', () => {
    expect(readConfig()).toEqual({ dataframeDropEnabled: false });
  });
});
