/** @fileoverview nasa_power_get_design_conditions wiring through the real service and both response surfaces. @module tests/mcp-server/tools/nasa-power-get-design-conditions */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDesignConditionsTool } from '@/mcp-server/tools/definitions/nasa-power-get-design-conditions.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/nasa-power-list-reference.tool.js';
import {
  DesignConditionsSchema,
  initPowerService,
  type PowerService,
  RECOVERIES,
} from '@/services/power/index.js';
import { fakePower, fixture, INDICATORS_HEADERS, monthValues } from '../../fake-power.js';
import { markdownText } from '../../markdown-text.js';

type Payload = Record<string, unknown> & { metadata: object; messages?: string[] };
const seattle = await fixture<Payload>('design-conditions-seattle-2020-2024.json');
const sparse = await fixture<Payload>('design-conditions-sparse.json');
const spanRejected = await fixture<Payload>('design-conditions-span-rejected.json');

const CONFIGURATION_PATH = '/api/application/indicators/configuration';
const POINT_PATH = '/api/application/indicators/point';
const INDICATORS_DOCS = 'https://power.larc.nasa.gov/docs/services/api/application/indicators/';
const SEATTLE = { latitude: 47.61, longitude: -122.33 };
const WINDOW = { startYear: 2020, endYear: 2024 };

let source: PowerService | undefined;
let sent: URL[] = [];
/** Initialize the real service over the captured Indicators upstream; `point` replaces its point answer. */
function serve(point?: (url: URL) => Response) {
  const fake = fakePower([]);
  source = initPowerService({
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      sent.push(url);
      return point && url.pathname === POINT_PATH ? point(url) : fake.fetch(url);
    },
    config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
  });
}
const pointUrls = () => sent.filter((url) => url.pathname === POINT_PATH);
/** Run the tool past the pacer's 2 s start gap (configuration, then point). */
async function call(args: Parameters<typeof runToolContract<typeof getDesignConditionsTool>>[1]) {
  const pending = runToolContract(getDesignConditionsTool, args);
  await vi.advanceTimersByTimeAsync(5_000);
  return pending;
}
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
/** A value as the decoded `content[]` lists it: nulls bare, arrays bracketed. */
const cell = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(cell).join(', ')}]` : String(value);
/** One structured entry as its decoded `content[]` record row. */
const row = (entry: object) => `[${Object.values(entry).map(cell).join(', ')}]`;
/** `key: value` for every leaf of a nested object, as the decoded `content[]` carries it. */
const leaves = (value: object): string[] =>
  Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? leaves(child)
      : [`${key}: ${cell(child)}`],
  );
/** Every indicator, monthly value and metadata field appears in the decoded `content[]`. */
function expectParity(result: Awaited<ReturnType<typeof runToolContract>>) {
  const data = DesignConditionsSchema.parse(result.structuredContent);
  expect(data).toEqual(result.structuredContent);
  const decoded = markdownText(text(result));
  for (const entry of [...data.indicators, ...data.monthly])
    expect(decoded, entry.code).toContain(row(entry));
  for (const line of leaves({ request: data.request, metadata: data.metadata }))
    expect(decoded).toContain(line);
  return { data, decoded };
}
function failure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  reason: keyof typeof RECOVERIES,
  code: JsonRpcErrorCode,
) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, recovery: { hint: RECOVERIES[reason] } } },
  });
  const decoded = markdownText(text(result));
  expect(decoded).toContain(RECOVERIES[reason]);
  expect(decoded).toContain(reason);
  return decoded;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
  sent = [];
});
afterEach(() => {
  source?.dispose();
  source = undefined;
  vi.useRealTimers();
});

describe('nasa_power_get_design_conditions', () => {
  it('declares read-only open-world hints and each service failure with its shared recovery', () => {
    expect(getDesignConditionsTool.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(
      getDesignConditionsTool.errors?.map(({ reason, recovery, thrownBy }) => ({
        reason,
        recovery,
        thrownBy,
      })),
    ).toEqual(
      (
        [
          'invalid_window',
          'upstream_rejected',
          'upstream_rate_limited',
          'request_queue_full',
        ] as const
      ).map((reason) => ({ reason, recovery: RECOVERIES[reason], thrownBy: 'service' })),
    );
  });

  it('returns every Seattle 2020-2024 value with header provenance on both surfaces', async () => {
    serve();
    const result = await call({ ...SEATTLE, ...WINDOW });
    expect(result.isError).not.toBe(true);
    const { data } = expectParity(result);
    expect([data.indicators.length, data.monthly.length]).toEqual([87, 38]);
    expect(data.request).toEqual({ ...SEATTLE, ...WINDOW });
    expect(data.metadata.api).toEqual({
      name: 'POWER Indicators API',
      version: INDICATORS_HEADERS['x-app-version'],
    });
    expect(data.metadata.sources).toEqual(INDICATORS_HEADERS['x-data-sources'].split(','));
    const scalars = Object.entries(seattle).filter(([, value]) => typeof value === 'number');
    const objects = Object.entries(seattle).filter(
      ([code, value]) => code !== 'metadata' && typeof value === 'object',
    );
    expect(Object.fromEntries(data.indicators.map((entry) => [entry.code, entry.value]))).toEqual(
      Object.fromEntries(scalars),
    );
    expect(Object.fromEntries(data.monthly.map((entry) => [entry.code, entry.values]))).toEqual(
      Object.fromEntries(objects.map(([code, value]) => [code, monthValues(value)])),
    );
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(40_000);
    expect(text(result).length).toBeLessThan(40_000);
    expect(pointUrls().map((url) => url.searchParams.has('units'))).toEqual([false]);
  });

  it('requests the configured coverage explicitly and echoes it when years are omitted', async () => {
    serve();
    const result = await call(SEATTLE);
    expect(result.isError).not.toBe(true);
    expect(
      sent.map((url) => [
        url.pathname,
        url.searchParams.get('start'),
        url.searchParams.get('end'),
        url.searchParams.has('units'),
      ]),
    ).toEqual([
      [CONFIGURATION_PATH, null, null, false],
      [POINT_PATH, '2001', '2025', false],
    ]);
    const { data } = expectParity(result);
    expect(data.request).toEqual({ ...SEATTLE, startYear: 2001, endYear: 2025 });
  });

  it('refuses a span under the configured minimum before any point request', async () => {
    serve();
    const result = await call({ ...SEATTLE, startYear: 2021, endYear: 2024 });
    const decoded = failure(result, 'invalid_window', JsonRpcErrorCode.ValidationError);
    expect(decoded).toContain(
      'Design-condition years must fall within 2001 to 2025 and span at least 5 years.',
    );
    expect(sent.map((url) => url.pathname)).toEqual([CONFIGURATION_PATH]);
  });

  it('renders a fill, an absent month and an uncatalogued key as null on both surfaces', async () => {
    serve(() => Response.json(sparse));
    const result = await call({ ...SEATTLE, ...WINDOW });
    expect(result.isError).not.toBe(true);
    const { data, decoded } = expectParity(result);
    const scalar = (code: string) => data.indicators.find((entry) => entry.code === code);
    const monthly = (code: string) => data.monthly.find((entry) => entry.code === code);
    expect(scalar('CD_DB_996')).toMatchObject({ label: 'Heating dry-bulb, 99.6%', value: null });
    expect(monthly('CD_T2M_AVG')?.values[6]).toBeNull();
    expect(scalar('CD_FUTURE_SCALAR')).toEqual({
      code: 'CD_FUTURE_SCALAR',
      section: null,
      label: null,
      units: null,
      value: 3.5,
    });
    expect(monthly('CD_FUTURE_MONTHLY')).toEqual({
      code: 'CD_FUTURE_MONTHLY',
      section: null,
      label: null,
      units: null,
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, null],
    });
    expect(data.metadata).toMatchObject({
      timezoneOffsetInHours: null,
      standardPressureInKpa: null,
    });
    /** No provenance headers: version and sources stay absent on both surfaces. */
    expect(data.metadata.api).toEqual({ name: 'POWER Indicators API' });
    expect(data.metadata).not.toHaveProperty('sources');
    expect(decoded).not.toMatch(/\b(?:version|sources):/);
    expect(decoded).toContain('[CD_FUTURE_SCALAR, null, null, null, 3.5]');
    /** A null renders bare, never as the text "null". */
    expect(text(result)).not.toMatch(/`\s*null\s*`/);
  });

  it('renders a payload without indicators as empty lists on both surfaces', async () => {
    serve(() => Response.json({ metadata: seattle.metadata }));
    const result = await call({ ...SEATTLE, ...WINDOW });
    expect(result.isError).not.toBe(true);
    const { data, decoded } = expectParity(result);
    expect([data.indicators, data.monthly]).toEqual([[], []]);
    expect(decoded).toContain('indicators: []');
    expect(decoded).toContain('monthly: []');
  });

  it('surfaces a NASA rejection as upstream_rejected with its messages', async () => {
    serve(() => Response.json(spanRejected, { status: 422 }));
    const result = await call({ ...SEATTLE, ...WINDOW });
    const decoded = failure(result, 'upstream_rejected', JsonRpcErrorCode.ValidationError);
    expect(result.structuredContent).toMatchObject({
      error: { data: { messages: spanRejected.messages } },
    });
    for (const message of spanRejected.messages ?? []) expect(decoded).toContain(message);
    expect(pointUrls()).toHaveLength(1);
  });

  it('rejects a units field at the input contract before any request', async () => {
    serve();
    const result = await runToolContract(getDesignConditionsTool, {
      ...SEATTLE,
      units: 'imperial',
    } as Parameters<typeof runToolContract<typeof getDesignConditionsTool>>[1]);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(sent).toEqual([]);
  });

  it('ends as cancelled on a caller abort mid-request and sends nothing further', async () => {
    const fake = fakePower([]);
    source = initPowerService({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push(url);
        if (url.pathname !== CONFIGURATION_PATH) return fake.fetch(url);
        /** The configuration answers after 1 s unless its request is aborted first. */
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(fake.fetch(url)), 1_000);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      },
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    const caller = new AbortController();
    const pending = runToolContract(
      getDesignConditionsTool,
      { ...SEATTLE, ...WINDOW },
      { context: { signal: caller.signal } },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((url) => url.pathname)).toEqual([CONFIGURATION_PATH]);
    caller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(sent.map((url) => url.pathname)).toEqual([CONFIGURATION_PATH]);
  });
});

describe('nasa_power_list_reference design-condition coverage', () => {
  it('lists the design-condition window and the Indicators docs on the coverage topic', async () => {
    const result = await runToolContract(listReferenceTool, { topic: 'coverage' });
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      documentationUrls: string[];
      entries: { code: string; earliestDate?: string; description: string }[];
    };
    const entry = data.entries.find(({ code }) => code === 'design_conditions');
    /** The tool takes no temporalResolution, so it serves none of the four temporal resolutions. */
    expect(entry).toEqual({
      code: 'design_conditions',
      earliestDate: '2001-01-01',
      resolutions: [],
      description: expect.stringContaining('at least 5 years'),
    });
    expect(entry?.description).toContain('nasa_power_get_design_conditions');
    expect(data.documentationUrls).toContain(INDICATORS_DOCS);
    expect(markdownText(text(result))).toContain(entry?.description);
    expect(text(result)).toContain(`[${INDICATORS_DOCS}](<${INDICATORS_DOCS}>)`);
  });

  it('renders every coverage entry as one row of a column table in content[]', async () => {
    const result = await runToolContract(listReferenceTool, { topic: 'coverage' });
    const { entries } = result.structuredContent as {
      entries: { code: string; description: string; resolutions: string[]; earliestDate: string }[];
    };
    const rendered = markdownText(text(result));
    expect(rendered).toContain(
      'entries: Records with ordered columns [code, description, resolutions, earliestDate]',
    );
    expect(entries).toHaveLength(4);
    for (const { code, description, resolutions, earliestDate } of entries)
      expect(rendered).toContain(
        `[${code}, ${description}, [${resolutions.join(', ')}], ${earliestDate}]`,
      );
  });

  it('keeps the Indicators docs off topics that do not cover design conditions', async () => {
    const result = await runToolContract(listReferenceTool, { topic: 'presets' });
    expect((result.structuredContent as { documentationUrls: string[] }).documentationUrls).toEqual(
      [
        'https://power.larc.nasa.gov/docs/services/api/',
        'https://power.larc.nasa.gov/docs/methodology/',
      ],
    );
    expect(text(result)).not.toContain(INDICATORS_DOCS);
  });
});
