/** @fileoverview Read literal text from CommonMark responses. @module tests/markdown-text */
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt('commonmark');

/** Decode Markdown syntax before comparing tool data across response surfaces. */
export function markdownText(value: string): string {
  const render = (tokens: ReturnType<typeof markdown.parse>): string =>
    tokens
      .map((token) => {
        if (token.children) return render(token.children);
        if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
        if (token.type === 'text' || token.type === 'code_inline' || token.type === 'fence')
          return token.content;
        return token.block && token.nesting === -1 ? '\n' : '';
      })
      .join('');
  return render(markdown.parse(value, {}));
}
