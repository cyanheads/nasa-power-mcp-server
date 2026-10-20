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
  it('boots with all four fixed canvas limits unset and shuts down on EOF', () => {
    const child = boot();
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  }, 25_000);

  it('refuses an explicitly incompatible memory limit', () => {
    const child = boot({ CANVAS_DEFAULT_MEMORY_LIMIT_MB: '128' });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('NASA POWER requires CANVAS_DEFAULT_MEMORY_LIMIT_MB=256');
  }, 25_000);
});
