/** @fileoverview Fixed POWER workload bounds and environment settings. @module config/server-config */
import { z } from '@cyanheads/mcp-ts-core';
import { parseConfig, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Immutable refusal boundaries, shared by producer and canvas services. */
export const POWER_LIMITS = {
  startGapMs: 2_000,
  queueDepth: 32,
  queueWaitMs: 15_000,
  /**
   * Producer admission is first-fit, so a call that fits may overtake one still waiting. Once the
   * oldest waiting call has waited this long, later calls queue behind it instead: a stream of
   * overlapping small calls cannot hold a large waiter's bytes until its admission wait ends.
   */
  queueOvertakeMs: 5_000,
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
  /**
   * Upper-bound sizing of one producing call's in-flight bytes (decoded bodies plus normalized
   * rows), computed from the request before fetching: a cold dictionary and configuration pair,
   * each upstream data response's header and parameter metadata, each regional grid cell's
   * feature wrapper, each normalized row's identity and period fields, and each value as both
   * source text and normalized column.
   *
   * The reference allowance is per resolution because the dictionary is: measured 2026-10-28
   * across RE, AG and SB, the dictionary body is ~32 KB hourly, ~46 KB daily, ~449 KB monthly and
   * ~561 KB climatology, and a configuration body ~0.3 KB. POWER sends these uncompressed, so the
   * figures are the decoded body bytes the call budget counts; each allowance carries ~25%
   * headroom for dictionary growth. A cached reference adds nothing, so this is the cold case.
   */
  estimateReferenceBytes: {
    hourly: 48 * 1024,
    daily: 64 * 1024,
    monthly: 576 * 1024,
    climatology: 704 * 1024,
  },
  estimateResponseBytes: 16 * 1024,
  estimateCellBytes: 256,
  estimateRowBytes: 384,
  estimateValueBytes: 96,
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
  maxCanvasesPerProcess: z.coerce
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(POWER_LIMITS.canvasesPerProcess)
    .describe('Maximum active or pending analytical canvases in this process'),
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
  if (!config) parseConfig();
  config ??= parseEnvConfig(ServerConfigSchema, {
    maxCanvasesPerProcess: 'NASA_POWER_MAX_CANVASES_PER_PROCESS',
    dataframeDropEnabled: 'NASA_POWER_DATAFRAME_DROP_ENABLED',
  });
  return config;
}
