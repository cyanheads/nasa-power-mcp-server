/** @fileoverview Upper-bound in-flight byte estimates for producing calls, computed before fetching. @module services/canvas/producer-estimate */
import { POWER_LIMITS } from '@/config/server-config.js';
import { requestedParameters } from '../power/normalize.js';
import { aliasMembership } from '../power/presets.js';
import type { CompareRequest, PowerRequest, RegionRequest, Resolution } from '../power/types.js';

/** Today's fixed worst case per producer kind: decoded bodies plus normalized rows. */
export const PRODUCER_CAP_BYTES = {
  single: POWER_LIMITS.bodyBytes + POWER_LIMITS.rowBytes,
  comparison: POWER_LIMITS.comparisonBodyBytes + POWER_LIMITS.rowBytes,
} as const;

const DAY_MS = 86_400_000;

type Window = {
  temporalResolution: Resolution;
  startDate?: string;
  endDate?: string;
  startYear?: number | undefined;
  endYear?: number | undefined;
};

/** Periods one location or cell can return: hours, days, 13 records per year, or 13 climatology records. */
function periods(window: Window): number {
  if (window.temporalResolution === 'climatology') return 13;
  if (window.temporalResolution === 'monthly')
    return 13 * Math.max(1, (window.endYear ?? 0) - (window.startYear ?? 0) + 1);
  const days = Math.max(
    1,
    Math.floor((Date.parse(window.endDate ?? '') - Date.parse(window.startDate ?? '')) / DAY_MS) +
      1,
  );
  return window.temporalResolution === 'hourly' ? days * 24 : days;
}

/** Returned columns; an alias group can expand to any number of members, bounded by the column cap. */
function columns(codes: string[]): number {
  return codes.some((code) => aliasMembership(code)) ? POWER_LIMITS.columns : codes.length;
}

function bytes(input: {
  resolution: Resolution;
  responses: number;
  cells: number;
  rows: number;
  values: number;
  extraBytes: number;
  cap: number;
}): number {
  return Math.min(
    input.cap,
    POWER_LIMITS.estimateReferenceBytes[input.resolution] +
      input.responses * POWER_LIMITS.estimateResponseBytes +
      input.cells * POWER_LIMITS.estimateCellBytes +
      input.rows * POWER_LIMITS.estimateRowBytes +
      input.values * POWER_LIMITS.estimateValueBytes +
      input.extraBytes,
  );
}

/** Upper bound for one point time series or climatology call. */
export function estimatePointBytes(request: PowerRequest): number {
  const rows = periods(request);
  return bytes({
    resolution: request.temporalResolution,
    responses: 1,
    cells: 0,
    rows,
    values: rows * columns(requestedParameters(request)),
    extraBytes: 0,
    cap: PRODUCER_CAP_BYTES.single,
  });
}

/** Upper bound for one regional call: grid points on the finest native grid (0.5° × 0.625°) inside the box. */
export function estimateRegionBytes(request: RegionRequest): number {
  const axis = (span: number, step: number) => Math.max(1, Math.floor(span / step + 1e-9) + 1);
  const cells =
    axis(request.latitudeMax - request.latitudeMin, 0.5) *
    axis(request.longitudeMax - request.longitudeMin, 0.625);
  const rows = cells * periods(request);
  return bytes({
    resolution: request.temporalResolution,
    responses: 1,
    cells,
    rows,
    values: rows * columns([request.parameter]),
    extraBytes: 0,
    cap: PRODUCER_CAP_BYTES.single,
  });
}

/** Upper bound for one comparison: every site's response and rows, each row tagged with its identity and label. */
export function estimateComparisonBytes(request: CompareRequest): number {
  const { locations, sort: _sort, ...shared } = request;
  /** Coordinates do not affect the selected codes. */
  const point: PowerRequest = { ...shared, latitude: 0, longitude: 0 };
  const codes = requestedParameters(point);
  const sitePeriods = periods(request);
  const identityBytes = locations.reduce(
    (sum, location, index) =>
      sum +
      Buffer.byteLength(
        JSON.stringify({ locationId: `location_${index + 1}`, label: location.label }),
      ),
    0,
  );
  const rows = sitePeriods * locations.length;
  return bytes({
    resolution: request.temporalResolution,
    responses: locations.length,
    cells: 0,
    rows,
    values: rows * columns(codes),
    extraBytes: sitePeriods * identityBytes,
    cap: PRODUCER_CAP_BYTES.comparison,
  });
}
