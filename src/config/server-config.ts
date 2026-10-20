/** @fileoverview Fixed POWER workload bounds and environment settings. @module config/server-config */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Immutable refusal boundaries, shared by producer and canvas services. */
export const POWER_LIMITS = {
  startGapMs: 2_000,
  queueDepth: 32,
  queueWaitMs: 15_000,
  deadlineMs: 55_000,
  attemptMs: 20_000,
  attempts: 2,
  comparisonAttempts: 12,
  bodyBytes: 16 * 1024 * 1024,
  comparisonBodyBytes: 32 * 1024 * 1024,
  rows: 250_000,
  columns: 64,
  rowBytes: 32 * 1024 * 1024,
  inlineCharacters: 40_000,
  cacheBytes: 64 * 1024 * 1024,
  cacheEntries: 128,
  referenceTtlMs: 86_400_000,
  dataTtlMs: 600_000,
  tenantRetainedBytes: 64 * 1024 * 1024,
  processRetainedBytes: 128 * 1024 * 1024,
  tenantInflightBytes: 64 * 1024 * 1024,
  processInflightBytes: 128 * 1024 * 1024,
  producers: 2,
  tablesPerCanvas: 8,
  canvasesPerTenant: 4,
  canvasesPerProcess: 8,
  tableTtlMs: 1_800_000,
  canvasTtlMs: 3_600_000,
  canvasAbsoluteTtlMs: 21_600_000,
  queryMs: 10_000,
  sqlCharacters: 16_384,
  queryRows: 1_000,
  queries: 4,
} as const;
/** Server-specific environment configuration. */
export const ServerConfigSchema = z.object({
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Enable explicit dataframe table removal'),
});
/** Parsed configuration consumed by services. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
let config: ServerConfig | undefined;
/** Lazy environment parsing keeps imports safe before runtime setup. */
export function getServerConfig(): ServerConfig {
  config ??= parseEnvConfig(ServerConfigSchema, {
    dataframeDropEnabled: 'NASA_POWER_DATAFRAME_DROP_ENABLED',
  });
  return config;
}
