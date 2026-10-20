/** @fileoverview Faithful analytical text rendering. @module tests/services/canvas/format */
import { describe, expect, it } from 'vitest';
import { formatFaithfully } from '@/services/canvas/format.js';

describe('analytical rendering', () => {
  it.each(['', ' ', '   ', ' a ', '`', 'a|b'])(
    'round-trips literal whitespace and punctuation %j',
    (value) => {
      const text = formatFaithfully({ label: value })[0]!.text;
      const fenced = [...text.matchAll(/^(`{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)];
      if (fenced.length) {
        expect(fenced.at(-1)![2]!.replace(/\n$/, '')).toBe(value);
        return;
      }
      const spans = [...text.matchAll(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g)];
      expect(spans.length).toBeGreaterThan(0);
      const raw = spans.at(-1)![2]!.replace(/\r\n?|\n/g, ' ');
      /** CommonMark strips one outer space only when the code span is not entirely spaces. */
      const rendered =
        raw.startsWith(' ') && raw.endsWith(' ') && /[^ ]/.test(raw) ? raw.slice(1, -1) : raw;
      expect(rendered).toBe(value);
    },
  );
  it('renders real multiline values, Markdown punctuation and clickable URLs', () => {
    const value = {
      rows: [
        { label: 'first line\nsecond | line ``` literal', url: 'https://example.org/a?b=1&c=2' },
      ],
    };
    const text = formatFaithfully(value)
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('first line\nsecond');
    expect(text).toContain('|');
    expect(text).toContain('``` literal');
    expect(text).toMatch(/\]\(<?https:\/\/example\.org\/a\?b=1&c=2>?\)/);
  });
});
