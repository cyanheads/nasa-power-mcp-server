/** @fileoverview Lossless scientific payload validation and normalization. @module services/power/normalize */
import { z } from '@cyanheads/mcp-ts-core';
import { POWER_LIMITS } from '../../config/server-config.js';
import { powerError, shapeError } from './errors.js';
import { aliasMembership, presetParameters } from './presets.js';
import { summarizeCells, summarizeRows } from './summarize.js';
import {
  type AccessMetadata,
  isDate,
  JsonValueSchema,
  type ObservationRow,
  type ParameterMetadata,
  type PowerDataset,
  type PowerMetadata,
  type PowerRequest,
  type RegionalDataset,
  type RegionRequest,
  type Resolution,
} from './types.js';

const jsonFields = z.record(z.string(), JsonValueSchema);
const HeaderSchema = z
  .object({
    api: z
      .object({ name: z.string().optional(), version: z.string().optional() })
      .catchall(JsonValueSchema)
      .optional(),
    sources: z.array(z.string()).optional(),
    fill_value: z.number().optional(),
    time_standard: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    range: z.string().optional(),
  })
  .catchall(JsonValueSchema);
const FeatureSchema = z
  .object({
    type: z.literal('Feature'),
    geometry: z
      .object({ type: z.literal('Point'), coordinates: z.array(z.number()).min(2).max(3) })
      .catchall(JsonValueSchema),
    properties: z
      .object({
        parameter: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))),
      })
      .catchall(JsonValueSchema),
  })
  .catchall(JsonValueSchema);
const sharedPayload = {
  header: HeaderSchema.optional(),
  parameters: z.record(z.string(), jsonFields).optional(),
  messages: z.array(z.string()).optional(),
};
/** Source schemas validate sparsity before any normalization. */
export const PointPayloadSchema = FeatureSchema.extend(sharedPayload);
export const RegionPayloadSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(FeatureSchema),
    ...sharedPayload,
  })
  .catchall(JsonValueSchema);
export type PointPayload = z.infer<typeof PointPayloadSchema>;
export type RegionPayload = z.infer<typeof RegionPayloadSchema>;
/** Effective requested parameter codes; corrections are included exactly once. */
export function requestedParameters(request: PowerRequest | RegionRequest): string[] {
  if ('parameter' in request) return [request.parameter];
  const codes =
    request.selection.mode === 'parameters'
      ? request.selection.parameters
      : presetParameters(request.selection.preset, request.temporalResolution);
  return [
    ...new Set([
      ...codes,
      ...(request.siteElevation !== undefined ? ['PSC'] : []),
      ...(request.windElevation !== undefined ? ['WSC'] : []),
    ]),
  ];
}
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Parse source identifiers without assigning an invented timezone to LST. */
export function parsePeriod(
  key: string,
  resolution: Resolution,
  timeStandard?: string,
): Pick<ObservationRow, 'periodKey' | 'periodKind' | 'date' | 'year' | 'month' | 'hour'> {
  const base = { periodKey: key, date: null, year: null, month: null, hour: null };
  if (resolution === 'climatology') {
    if (key === 'ANN') return { ...base, periodKind: 'climatology_annual' };
    const month = months.indexOf(key) + 1;
    if (month > 0) return { ...base, periodKind: 'climatology_month', month };
  } else if (resolution === 'monthly' && /^\d{6}$/.test(key)) {
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(4));
    if (year > 0 && month === 13) return { ...base, year, periodKind: 'annual' };
    const date = `${key.slice(0, 4)}-${key.slice(4)}-01`;
    if (isDate(date)) return { ...base, year, month, date, periodKind: 'month' };
  } else if (
    (resolution === 'daily' && /^\d{8}$/.test(key)) ||
    (resolution === 'hourly' && /^\d{10}$/.test(key))
  ) {
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    const hour = resolution === 'hourly' ? Number(key.slice(8)) : null;
    if (isDate(date) && (hour === null || hour <= 23))
      return {
        ...base,
        year: Number(key.slice(0, 4)),
        month: Number(key.slice(4, 6)),
        hour,
        date:
          hour === null
            ? date
            : `${date}T${key.slice(8)}:00:00${timeStandard === 'UTC' ? 'Z' : ''}`,
        periodKind: hour === null ? 'day' : 'hour',
      };
  }
  throw shapeError(`Unrecognized ${resolution} period key: ${key}`);
}
function metadata(
  payload: PointPayload | RegionPayload,
  request: PowerRequest | RegionRequest,
  access: AccessMetadata,
): PowerMetadata {
  const header = payload.header;
  const { api, sources, fill_value, time_standard, start, end, range, ...headerExtra } =
    header ?? {};
  const {
    header: _header,
    parameters: _parameters,
    messages: _messages,
    features: _features,
    geometry: _geometry,
    properties: _properties,
    type: _type,
    ...topExtra
  } = payload;
  return {
    endpointUrl: access.endpointUrl,
    fetchedAt: access.fetchedAt,
    cacheHit: access.cacheHit,
    unitsMode: request.units,
    messages: payload.messages ?? [],
    ...(api
      ? {
          api: {
            ...(api.name !== undefined ? { name: api.name } : {}),
            ...(api.version !== undefined ? { version: api.version } : {}),
          },
        }
      : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(fill_value !== undefined ? { fillValue: fill_value } : {}),
    ...(time_standard !== undefined ? { timeStandard: time_standard } : {}),
    ...(start !== undefined ? { reportedStart: start } : {}),
    ...(end !== undefined ? { reportedEnd: end } : {}),
    ...(range !== undefined ? { range } : {}),
    ...('latitude' in request
      ? { requestedCoordinates: { latitude: request.latitude, longitude: request.longitude } }
      : {}),
    extra: { ...topExtra, header: headerExtra },
  };
}
function parameters(payload: PointPayload | RegionPayload): ParameterMetadata[] {
  const features = payload.type === 'FeatureCollection' ? payload.features : [payload];
  const codes = new Set(features.flatMap((feature) => Object.keys(feature.properties.parameter)));
  if (codes.size > POWER_LIMITS.columns)
    throw powerError('dataset_limit', 'NASA returned too many scientific parameter columns.');
  return [...codes].sort().map((code) => {
    const { units, longname, ...extra } = payload.parameters?.[code] ?? {};
    if (
      (units !== undefined && typeof units !== 'string') ||
      (longname !== undefined && typeof longname !== 'string')
    )
      throw shapeError(`Invalid metadata for ${code}`);
    return {
      code,
      ...(typeof units === 'string' ? { units } : {}),
      ...(typeof longname === 'string' ? { longName: longname } : {}),
      valueKind:
        code === 'T_ZONES' || code === 'TM_ZONES'
          ? 'categorical'
          : units === 'N/S Orientation' || code.endsWith('_ORT')
            ? 'orientation'
            : 'number',
      extra,
    };
  });
}
/** Retain missing-key provenance outside rows so the table remains ordinary scientific data. */
export type MissingProvenance = Map<string, Map<string, 'fill' | 'absent'>>;
function featureRows(
  feature: z.infer<typeof FeatureSchema>,
  request: PowerRequest | RegionRequest,
  meta: PowerMetadata,
  params: ParameterMetadata[],
  cellId?: string,
): { rows: ObservationRow[]; missing: MissingProvenance } {
  const [longitude, latitude, elevation] = feature.geometry.coordinates;
  if (
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    throw shapeError('Invalid source coordinates');
  const series = feature.properties.parameter;
  const keys = [...new Set(Object.values(series).flatMap((values) => Object.keys(values)))];
  if (keys.length > POWER_LIMITS.rows)
    throw powerError('dataset_limit', 'Source profile exceeds the observation row limit.');
  const parsed = keys.map((key) => parsePeriod(key, request.temporalResolution, meta.timeStandard));
  parsed.sort(
    (a, b) =>
      (a.year ?? 0) - (b.year ?? 0) ||
      (a.month ?? 13) - (b.month ?? 13) ||
      a.periodKey.localeCompare(b.periodKey),
  );
  const missing: MissingProvenance = new Map();
  const rows = parsed.map((period) => {
    const row: ObservationRow = {
      ...period,
      latitude,
      longitude,
      elevation: elevation ?? null,
      ...(cellId ? { cellId } : {}),
    };
    for (const parameter of params) {
      const value = series[parameter.code]?.[period.periodKey];
      if (value === undefined || (meta.fillValue !== undefined && value === meta.fillValue)) {
        row[parameter.code] = null;
        let reasons = missing.get(parameter.code);
        if (!reasons) {
          reasons = new Map();
          missing.set(parameter.code, reasons);
        }
        reasons.set(period.periodKey, value === undefined ? 'absent' : 'fill');
      } else if (
        (parameter.valueKind !== 'orientation' &&
          typeof value === 'number' &&
          Number.isFinite(value)) ||
        (parameter.valueKind === 'orientation' && typeof value === 'string')
      )
        row[parameter.code] = value;
      else
        throw shapeError(
          `Unexpected ${parameter.valueKind} value for ${parameter.code} at ${period.periodKey}`,
        );
    }
    return row;
  });
  return { rows, missing };
}
function omissions(
  request: PowerRequest | RegionRequest,
  params: ParameterMetadata[],
  messages: string[],
) {
  const codes = new Set(params.map((parameter) => parameter.code));
  const requested = requestedParameters(request);
  const expansions = Object.fromEntries(
    requested.flatMap((code) => {
      const isMember = aliasMembership(code);
      if (!isMember) return [];
      const members = [...codes].filter(isMember);
      return members.length ? [[code, members]] : [];
    }),
  );
  return {
    expansions,
    omittedParameters: requested
      .filter((code) => !codes.has(code) && !Object.hasOwn(expansions, code))
      .map((code) => ({ code, messages })),
  };
}
/** Enforce exact serialized UTF-8 row and count bounds before presentation. */
export function assertDatasetBounds(rows: ObservationRow[]): number {
  if (rows.length > POWER_LIMITS.rows)
    throw powerError('dataset_limit', 'Dataset exceeds the observation row limit.');
  let bytes = 2;
  const encoder = new TextEncoder();
  for (const row of rows) {
    bytes += encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (bytes > POWER_LIMITS.rowBytes)
      throw powerError('dataset_limit', 'Dataset exceeds the normalized row byte limit.');
  }
  return rows.length ? bytes - 1 : bytes;
}
/** Normalize one validated point without network or clock access. */
export function normalizePoint(
  payload: PointPayload,
  request: PowerRequest,
  access: AccessMetadata,
): PowerDataset {
  const meta = metadata(payload, request, access);
  const params = parameters(payload);
  const { rows, missing } = featureRows(payload, request, meta, params);
  assertDatasetBounds(rows);
  const first = rows[0];
  if (first)
    meta.returnedCoordinates = {
      latitude: first.latitude,
      longitude: first.longitude,
      elevation: first.elevation,
    };
  else {
    const [longitude, latitude, elevation] = payload.geometry.coordinates;
    if (latitude !== undefined && longitude !== undefined)
      meta.returnedCoordinates = { latitude, longitude, elevation: elevation ?? null };
  }
  return {
    request,
    metadata: meta,
    parameters: params,
    ...omissions(request, params, meta.messages),
    summaries: summarizeRows(rows, params, missing),
    rows,
  };
}
/** Normalize all returned grid cells, preserving their stable feature order. */
export function normalizeRegion(
  payload: RegionPayload,
  request: RegionRequest,
  access: AccessMetadata,
): RegionalDataset {
  const meta = metadata(payload, request, access);
  const params = parameters(payload);
  const rows: ObservationRow[] = [];
  for (const [index, feature] of payload.features.entries()) {
    const next = featureRows(feature, request, meta, params, `cell_${index + 1}`).rows;
    if (rows.length + next.length > POWER_LIMITS.rows)
      throw powerError('dataset_limit', 'Regional dataset exceeds the observation row limit.');
    rows.push(...next);
  }
  assertDatasetBounds(rows);
  return {
    request,
    metadata: meta,
    parameters: params,
    ...omissions(request, params, meta.messages),
    cellCount: payload.features.length,
    summaries: summarizeCells(rows, params, payload.features.length),
    rows,
  };
}
