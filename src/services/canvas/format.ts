/** @fileoverview Compact faithful analytical rendering. @module services/canvas/format */
import { markdownLink } from '@cyanheads/mcp-ts-core/utils';

/** Preserve every value and newline, even when values contain Markdown fences. */
export function formatFaithfully(value: object) {
  const literal = (text: string): string => {
    if (text.trim().length > 0 && !text.includes('\n') && !text.includes('\r')) {
      const fence = '`'.repeat(
        Math.max(1, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
      );
      return `${fence} ${text} ${fence}`;
    }
    const fence = '`'.repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
    );
    return `\n${fence}text\n${text}\n${fence}\n`;
  };
  const render = (item: unknown): string => {
    if (typeof item === 'string') {
      if (/^https?:\/\/[^\s<>]+$/.test(item)) return markdownLink(item, item);
      const links = [...item.matchAll(/https?:\/\/[^\s<>]+/g)].map(([url]) =>
        markdownLink(url, url),
      );
      return [literal(item), ...links].join('\n\n');
    }
    if (Array.isArray(item)) {
      const first = item[0];
      if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        const columns = Object.keys(first);
        if (
          item.every(
            (row) =>
              row !== null &&
              typeof row === 'object' &&
              !Array.isArray(row) &&
              JSON.stringify(Object.keys(row)) === JSON.stringify(columns),
          )
        ) {
          return `Records with ordered columns ${render(columns)}\n\n[\n${item.map((row) => `[${Object.values(row).map(render).join(', ')}]`).join(',\n')}\n]`;
        }
      }
      return item.length ? `[${item.map(render).join(', ')}]` : '[]';
    }
    if (item !== null && typeof item === 'object')
      return Object.keys(item).length
        ? `{\n${Object.entries(item)
            .map(([key, child]) => `${literal(key)}: ${render(child)}`)
            .join('\n\n')}\n}`
        : '{}';
    return JSON.stringify(item);
  };
  return [
    {
      type: 'text' as const,
      text: render(value),
    },
  ];
}
