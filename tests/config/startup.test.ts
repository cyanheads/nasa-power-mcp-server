/** @fileoverview Real Node startup applies bounded DuckDB defaults. @module tests/config/startup */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let temporaryDirectory: string;

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'nasa-power-startup-'));
  symlinkSync(join(root, 'node_modules'), join(temporaryDirectory, 'node_modules'), 'dir');
  // The bundled entry resolves `createApp({ skills: 'skills' })` against its own directory.
  symlinkSync(join(root, 'skills'), join(temporaryDirectory, 'skills'), 'dir');
  const build = spawnSync(
    'bun',
    [
      'build',
      join(root, 'src/index.ts'),
      '--target=node',
      '--packages=external',
      '--outfile',
      join(temporaryDirectory, 'index.mjs'),
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 },
  );
  expect(build.error, build.stderr).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);
});
afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

function boot(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [join(temporaryDirectory, 'index.mjs')], {
    cwd: temporaryDirectory,
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_AUTH_MODE: 'none',
      CANVAS_PROVIDER_TYPE: 'duckdb',
      LOG_LEVEL: 'error',
      ...extra,
    },
    input: '',
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('DuckDB startup workload defaults', () => {
  it.each(['', `${'$'}{OPTION}`])(
    'defaults blank or placeholder sizing: %s',
    (value) => {
      const child = boot(
        Object.fromEntries(
          [
            'CANVAS_DEFAULT_MEMORY_LIMIT_MB',
            'CANVAS_MAX_CANVASES_PER_TENANT',
            'CANVAS_TTL_MS',
            'CANVAS_ABSOLUTE_CAP_MS',
            'NASA_POWER_MAX_CANVASES_PER_PROCESS',
          ].map((key) => [key, value]),
        ),
      );
      expect(child.status, child.stderr).toBe(0);
    },
    25_000,
  );

  it('honors explicit capacity and ordered native lifetimes', () => {
    const child = boot({
      CANVAS_MAX_CANVASES_PER_TENANT: '500',
      CANVAS_TTL_MS: '60000',
      CANVAS_ABSOLUTE_CAP_MS: '120000',
      NASA_POWER_MAX_CANVASES_PER_PROCESS: '8',
    });
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);

  it.each([
    ['CANVAS_DEFAULT_MEMORY_LIMIT_MB', '63'],
    ['CANVAS_MAX_CANVASES_PER_TENANT', '0'],
    ['CANVAS_TTL_MS', '-1'],
    ['CANVAS_ABSOLUTE_CAP_MS', '1'],
    ['NASA_POWER_MAX_CANVASES_PER_PROCESS', '0'],
    ['NASA_POWER_MAX_CANVASES_PER_PROCESS', '1.5'],
  ])(
    'rejects invalid %s=%s before startup',
    (key, value) => {
      const child = boot({ [key]: value });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain(key);
    },
    25_000,
  );
  it('boots with all four fixed canvas limits unset and shuts down on EOF', () => {
    const child = boot();
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);

  it('honors explicit native canvas sizing', () => {
    const child = boot({ CANVAS_DEFAULT_MEMORY_LIMIT_MB: '128' });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);

  it('defaults a blank provider to DuckDB with explicit sizing', () => {
    const child = boot({ CANVAS_PROVIDER_TYPE: '', CANVAS_DEFAULT_MEMORY_LIMIT_MB: '128' });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);

  it('keeps an explicit none provider without DuckDB limits', () => {
    const child = boot({ CANVAS_PROVIDER_TYPE: 'none', CANVAS_DEFAULT_MEMORY_LIMIT_MB: '128' });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);
});
