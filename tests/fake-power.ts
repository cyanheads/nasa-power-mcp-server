/** @fileoverview Deterministic offline NASA POWER upstream that answers any requested window, point, box and code list. @module tests/fake-power */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_MS = 86_400_000;

/** Source-shaped values with realistic widths: two decimals, signs, magnitudes up to hundreds. */
function value(seed: number): number {
  return Number(((((seed * 7919) % 100_003) / 100_003) * 400 - 150).toFixed(2));
}

function keys(resolution: string, query: URLSearchParams): string[] {
  const start = query.get('start') ?? '';
  const end = query.get('end') ?? '';
  if (resolution === 'climatology') return [...MONTHS, 'ANN'];
  if (resolution === 'monthly')
    return Array.from({ length: Number(end) - Number(start) + 1 }, (_, index) => [
      ...Array.from(
        { length: 12 },
        (_, month) => `${Number(start) + index}${String(month + 1).padStart(2, '0')}`,
      ),
      `${Number(start) + index}13`,
    ]).flat();
  const first = Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8));
  const last = Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8));
  const days = Array.from({ length: (last - first) / DAY_MS + 1 }, (_, index) =>
    new Date(first + index * DAY_MS).toISOString().slice(0, 10).replaceAll('-', ''),
  );
  return resolution === 'hourly'
    ? days.flatMap((day) =>
        Array.from({ length: 24 }, (_, hour) => `${day}${String(hour).padStart(2, '0')}`),
      )
    : days;
}

/** Requested codes; a SI_TILTED_* group expands to members named `<group>_<suffix>`. */
function series(codes: string[], periodKeys: string[], salt: number) {
  const members = (code: string) =>
    code.startsWith('SI_TILTED_')
      ? ['HORIZONTAL', 'LATITUDE', 'LAT_MINUS15', 'LAT_PLUS15', 'VERTICAL', 'OPTIMAL'].map(
          (suffix) => `${code}_${suffix}`,
        )
      : [code];
  return Object.fromEntries(
    codes
      .flatMap(members)
      .map((code, column) => [
        code,
        Object.fromEntries(
          periodKeys.map((key, index) => [key, value(salt * 1_000_003 + column * 10_007 + index)]),
        ),
      ]),
  );
}

/** Solar codes POWER serves on its 1° grid; every other code is on the 0.5° × 0.625° meteorology grid. */
const SOLAR = /^(ALLSKY|CLRSKY|TOA)_/;

/** Native grid points (`origin + index × step`) inside the inclusive range, as POWER selects cell centers. */
function grid(min: number, max: number, step: number, origin: number): number[] {
  const points: number[] = [];
  for (
    let index = Math.ceil((min - origin) / step - 1e-9);
    origin + index * step <= max + 1e-9;
    index++
  )
    points.push(Number((origin + index * step).toFixed(4)));
  return points;
}

/** A response that streams `bytes` zero bytes as one chunk, then fails mid-body or ends with `status`. */
export function streamedBody(bytes: number, end: 'error' | { status: number }): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(bytes));
      } else if (end === 'error') controller.error(new TypeError('terminated'));
      else controller.close();
    },
  });
  return new Response(body, end === 'error' ? {} : end);
}

/**
 * Fake fetch: dictionaries list `codes`, configurations are empty, and observations cover exactly
 * the requested window, coordinates and codes. `requests` records every observation URL.
 * `dictionaryBytes` pads each resolution's dictionary body to a measured real size with one
 * filler entry, so a cold call reads reference bytes like the live service.
 */
export function fakePower(
  codes: string[],
  options: { dictionaryBytes?: Partial<Record<string, number>> } = {},
) {
  const requests: URL[] = [];
  const dictionary = (resolution: string) => {
    const entries: Record<string, object> = Object.fromEntries(codes.map((code) => [code, {}]));
    const target = options.dictionaryBytes?.[resolution] ?? 0;
    const bare = JSON.stringify({ ...entries, FILLER: { definition: '' } }).length;
    if (target > bare) entries.FILLER = { definition: 'x'.repeat(target - bare) };
    return entries;
  };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'power.larc.nasa.gov') throw new Error(`Unexpected host ${url.hostname}`);
    if (url.pathname.endsWith('/parameters'))
      return Response.json(dictionary(url.searchParams.get('temporal') ?? ''));
    if (url.pathname.endsWith('/configuration')) return Response.json({});
    requests.push(url);
    const resolution = url.pathname.split('/')[3] ?? '';
    const query = url.searchParams;
    const requested = (query.get('parameters') ?? '').split(',');
    const periodKeys = keys(resolution, query);
    const header = {
      api: { name: 'POWER', version: 'v2.8.0' },
      fill_value: -999,
      time_standard: query.get('time-standard') ?? 'LST',
      sources: ['MERRA2', 'POWER'],
    };
    const feature = (latitude: number, longitude: number, salt: number) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [longitude, latitude, 120.5] },
      properties: { parameter: series(requested, periodKeys, salt) },
    });
    const parameters = Object.fromEntries(
      Object.keys(series(requested, [], 0)).map((code) => [
        code,
        { units: 'C', longname: `${code} long name` },
      ]),
    );
    if (url.pathname.endsWith('/point')) {
      const latitude = Number(query.get('latitude'));
      const longitude = Number(query.get('longitude'));
      return Response.json({
        ...feature(latitude, longitude, Math.round(latitude * 100 + longitude)),
        header,
        parameters,
        messages: [],
      });
    }
    /** A regional call carries one code; solar cells are centered at x.5 on 1° steps. */
    const solar = requested.every((code) => SOLAR.test(code));
    const lats = grid(
      Number(query.get('latitude-min')),
      Number(query.get('latitude-max')),
      solar ? 1 : 0.5,
      solar ? -89.5 : -90,
    );
    const lons = grid(
      Number(query.get('longitude-min')),
      Number(query.get('longitude-max')),
      solar ? 1 : 0.625,
      solar ? -179.5 : -180,
    );
    return Response.json({
      type: 'FeatureCollection',
      features: lats.flatMap((latitude) =>
        lons.map((longitude) =>
          feature(latitude, longitude, Math.round(latitude * 100 + longitude)),
        ),
      ),
      header,
      parameters,
      messages: [],
    });
  };
  return { fetch, requests };
}
