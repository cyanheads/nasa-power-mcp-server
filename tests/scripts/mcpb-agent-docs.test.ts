/**
 * @fileoverview Bundle agent-doc selection keeps runtime `skills/` modules.
 * @module tests/scripts/mcpb-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL at run time: a literal specifier would pull the script into the
 * `tsc` program, and its repository-only skill-validator fallback import does
 * not resolve in a server (cyanheads/mcp-ts-core#797).
 */
const lintPackaging = (await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
)) as {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
};

const keptEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/some-pkg/docs/SKILL.md',
  'node_modules/@scope/skills/index.js',
  'dist/index.js',
  'skills/nasa-power-guide/SKILL.md',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/references/notes.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/some-pkg/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/guide/SKILL.md',
  'node_modules/@a/outer/node_modules/@b/inner/framework-skills/x/SKILL.md',
];

describe('bundle agent-doc selection', () => {
  it('keeps runtime skills modules and paths below a package root', () => {
    expect(filterAgentDocEntries(keptEntries)).toEqual([]);
  });

  it("selects a package root's own agent docs at any nesting depth", () => {
    expect(filterAgentDocEntries(agentDocEntries)).toEqual(agentDocEntries);
  });

  it('matches the post-bundle packaging check entry for entry', () => {
    for (const entry of [...keptEntries, ...agentDocEntries]) {
      expect(lintPackaging.AGENT_DOC_ENTRY.test(entry), entry).toBe(
        filterAgentDocEntries([entry]).length === 1,
      );
    }
  });

  it('passes a bundle holding the SDK runtime skills modules and flags package-root docs', () => {
    expect(lintPackaging.checkBundleEntries(keptEntries, 'bundle')).toEqual([]);
    const [error] = lintPackaging.checkBundleEntries(
      [...keptEntries, 'node_modules/some-pkg/skills/guide/SKILL.md'],
      'bundle',
    );
    expect(error).toContain('1 node_modules agent-doc entries');
    expect(error).toContain('node_modules/some-pkg/skills/guide/SKILL.md');
  });
});
