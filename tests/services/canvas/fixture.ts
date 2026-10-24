/** @fileoverview Real native canvas test boundary. @module tests/services/canvas/fixture */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { POWER_LIMITS } from '@/config/server-config.js';
import { initCanvasService } from '@/services/canvas/index.js';
import type { ObservationRow, ParameterMetadata } from '@/services/power/types.js';

/** Scientific rows exceed inline bounds while retaining later fractions and orientation text. */
export function dataset(count = 400) {
  const parameters: ParameterMetadata[] = [
    { code: 'T2M', units: 'C', valueKind: 'number', extra: {} },
    { code: 'ORT', units: 'direction', valueKind: 'orientation', extra: {} },
  ];
  const rows: ObservationRow[] = Array.from({ length: count }, (_, index) => ({
    periodKey: String(index),
    periodKind: 'day',
    date: null,
    year: 2024,
    month: 1,
    hour: null,
    latitude: 47.6,
    longitude: -122.3,
    elevation: null,
    T2M: index < 110 ? null : index < 200 ? 0 : index + 0.125,
    ORT: index < 110 ? null : 'south | ``` facing',
    label: 'Seattle\nobservations',
  }));
  return {
    rows,
    parameters,
    metadata: {
      sources: ['https://power.larc.nasa.gov/'],
      nested: { values: [null, 0, 'source\nline'] },
    },
  };
}

/** Build native engine, registry and service; only state and wall clock are test boundaries. */
export async function nativeFixture(
  dropEnabled = true,
  sizing: {
    maxCanvasesPerProcess?: number;
    maxCanvasesPerTenant?: number;
    ttlMs?: number;
    absoluteCapMs?: number;
    memoryLimitMb?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'nasa-power-canvas-test-'));
  let clock = Date.now();
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: directory,
    tempRootPath: directory,
    memoryLimitMb: sizing.memoryLimitMb ?? 256,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(
    provider,
    {
      absoluteCapMs: sizing.absoluteCapMs ?? POWER_LIMITS.canvasAbsoluteTtlMs,
      maxCanvasesPerTenant: sizing.maxCanvasesPerTenant ?? 20,
      sweeperIntervalMs: 0,
      ttlMs: sizing.ttlMs ?? POWER_LIMITS.canvasTtlMs,
    },
    () => clock,
  );
  const canvas = new DataCanvas(provider, registry);
  const ctx = createMockContext();
  const storage = createInMemoryStorage();
  const service = initCanvasService({
    canvas,
    storage,
    config: {
      maxCanvasesPerProcess: sizing.maxCanvasesPerProcess ?? 8,
      dataframeDropEnabled: dropEnabled,
    },
    canvasLimits: {
      maxCanvasesPerTenant: sizing.maxCanvasesPerTenant ?? POWER_LIMITS.canvasesPerTenant,
      absoluteCapMs: sizing.absoluteCapMs ?? POWER_LIMITS.canvasAbsoluteTtlMs,
    },
    now: () => clock,
    reconciliationMs: 60_000,
  });
  return {
    service,
    canvas,
    provider,
    registry,
    ctx,
    storage,
    advance(ms: number) {
      clock += ms;
    },
    async close() {
      await service.shutdown();
      await canvas.shutdown(ctx);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
