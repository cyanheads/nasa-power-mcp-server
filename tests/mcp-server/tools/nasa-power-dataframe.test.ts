/** @fileoverview Real dataframe handlers and both response surfaces. @module tests/mcp-server/tools/nasa-power-dataframe */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-query.tool.js';
import { dataset, nativeFixture } from '../../services/canvas/fixture.js';

describe('dataframe tool contract', () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
  });
  afterEach(async () => {
    await fixture.close();
  });
  async function stage() {
    return (
      await fixture.service.present(dataset(), undefined, fixture.ctx, 'nasa_power_get_timeseries')
    ).dataset!;
  }

  it('renders query structured rows and real multiline strings on the content surface', async () => {
    const handle = await stage();
    const result = await runToolContract(dataframeQueryTool, {
      canvas_id: handle.canvas_id,
      sql: `SELECT label, ORT, T2M FROM ${handle.table} WHERE T2M > 0 ORDER BY T2M`,
      rowLimit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      canvas_id: handle.canvas_id,
      shownCount: 2,
      truncated: true,
      countSemantics: 'materialized_prefix',
      rows: [
        { label: 'Seattle\nobservations', ORT: 'south | ``` facing', T2M: 200.125 },
        { label: 'Seattle\nobservations', ORT: 'south | ``` facing', T2M: 201.125 },
      ],
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const value of [
      handle.canvas_id,
      'label',
      'Seattle\nobservations',
      'south | ``` facing',
      '200.125',
      '201.125',
      'materialized_prefix',
    ])
      expect(text).toContain(value);
  });
  it('describes the real schema and nested scientific provenance on both surfaces', async () => {
    const handle = await stage();
    const ctx = {
      ...createMockContext({ errors: dataframeDescribeTool.errors }),
      state: fixture.ctx.state,
    };
    const output = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ canvas_id: handle.canvas_id }),
      ctx,
    );
    expect(dataframeDescribeTool.output!.parse(output)).toEqual(output);
    expect(output.tables[0]).toMatchObject({
      table: handle.table,
      rowCount: 400,
      provenance: {
        sourceTool: 'nasa_power_get_timeseries',
        envelope: { metadata: dataset().metadata },
      },
    });
    const text = dataframeDescribeTool.format!(output)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const value of [
      handle.canvas_id,
      handle.table,
      'source\nline',
      'sourceTool',
      'T2M',
      'DOUBLE',
      'direction',
      '400',
    ])
      expect(text).toContain(value);
    expect(text).toMatch(/\]\(<?https:\/\/power\.larc\.nasa\.gov\/>?\)/);
  });
  it('mirrors classified failures and recovery text into content and structuredContent', async () => {
    const handle = await stage();
    for (const [sql, reason] of [
      ['SELECT FROM', 'invalid_sql'],
      ['SELECT * FROM not_here', 'missing_table'],
      ['SELECT 1; SELECT 2', 'multi_statement'],
      ["SELECT current_setting('memory_limit')", 'denied_function'],
    ]) {
      const result = await runToolContract(dataframeQueryTool, {
        canvas_id: handle.canvas_id,
        sql: sql!,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(reason!);
    }
  });
  it('rejects malformed tokens, empty SQL and invalid row bounds at the public boundary', async () => {
    for (const input of [
      { canvas_id: 'bad', sql: 'SELECT 1' },
      { canvas_id: 'abcdefghij', sql: '' },
      { canvas_id: 'abcdefghij', sql: 'SELECT 1', rowLimit: 0 },
      { canvas_id: 'abcdefghij', sql: 'SELECT 1', rowLimit: 1001 },
    ])
      expect((await runToolContract(dataframeQueryTool, input)).isError).toBe(true);
  });
  it('returns exact empty rows on both query surfaces beyond the staged end', async () => {
    const handle = await stage();
    const result = await runToolContract(dataframeQueryTool, {
      canvas_id: handle.canvas_id,
      sql: `SELECT T2M FROM ${handle.table} OFFSET 400`,
    });
    expect(result.structuredContent).toMatchObject({
      rows: [],
      rowCount: 0,
      shownCount: 0,
      truncated: false,
      countSemantics: 'exact',
    });
    expect(
      result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    ).toContain('exact');
  });
  it('drops the real table and formats both idempotent outcomes completely', async () => {
    const handle = await stage();
    for (const dropped of [true, false]) {
      const output = await dataframeDropTool.handler(
        dataframeDropTool.input.parse({ canvas_id: handle.canvas_id, table: handle.table }),
        createMockContext({ errors: dataframeDropTool.errors }),
      );
      expect(output).toEqual({ canvas_id: handle.canvas_id, table: handle.table, dropped });
      const text = dataframeDropTool.format!(output)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      for (const value of [handle.canvas_id, handle.table, String(dropped)])
        expect(text).toContain(value);
    }
  });
});
