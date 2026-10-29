# nasa-power-mcp-server - Directory Structure

Generated on: 2026-10-29 05:05:53

```text
nasa-power-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   └── nasa-power-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── comparison-contracts.ts
│   │           ├── nasa-power-compare-locations.tool.ts
│   │           ├── nasa-power-dataframe-describe.tool.ts
│   │           ├── nasa-power-dataframe-drop.tool.ts
│   │           ├── nasa-power-dataframe-query.tool.ts
│   │           ├── nasa-power-get-climatology.tool.ts
│   │           ├── nasa-power-get-region.tool.ts
│   │           ├── nasa-power-get-timeseries.tool.ts
│   │           ├── nasa-power-list-reference.tool.ts
│   │           ├── nasa-power-search-parameters.tool.ts
│   │           └── point-contracts.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── canvas-service.ts
│   │   │   ├── errors.ts
│   │   │   ├── format.ts
│   │   │   ├── index.ts
│   │   │   ├── inline-split.ts
│   │   │   ├── producer-estimate.ts
│   │   │   └── types.ts
│   │   └── power/
│   │       ├── errors.ts
│   │       ├── index.ts
│   │       ├── normalize.ts
│   │       ├── power-service.ts
│   │       ├── presets.ts
│   │       ├── summarize.ts
│   │       ├── types.ts
│   │       └── unserved-parameters.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config.test.ts
│   │   └── startup.test.ts
│   ├── fixtures/
│   │   ├── climate-zones.json
│   │   ├── comparison-full.json
│   │   ├── hour-extremes-regional.json
│   │   ├── hour-group-monthly.json
│   │   ├── hour-tracker-climatology.json
│   │   ├── region-annual-summaries.json
│   │   ├── region-annual.json
│   │   ├── tilted-groups.json
│   │   └── tilted-wide.json
│   ├── fuzz/
│   ├── integration/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── nasa-power-climatology-native.test.ts
│   │       ├── nasa-power-dataframe-gating.test.ts
│   │       ├── nasa-power-dataframe.test.ts
│   │       ├── nasa-power-geographic-native.test.ts
│   │       ├── nasa-power-geographic.test.ts
│   │       ├── nasa-power-point-discovery.test.ts
│   │       ├── nasa-power-reference-config.test.ts
│   │       ├── nasa-power-reference-size-recovery.test.ts
│   │       └── nasa-power-regional-summaries.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── scripts/
│   │   └── mcpb-agent-docs.test.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── canvas-service.test.ts
│   │   │   ├── configured-limits.test.ts
│   │   │   ├── failure-boundaries.test.ts
│   │   │   ├── fixture.ts
│   │   │   ├── format.test.ts
│   │   │   ├── inline-split.test.ts
│   │   │   ├── producer-estimate.test.ts
│   │   │   ├── request-lifetime.test.ts
│   │   │   └── response-budget.test.ts
│   │   └── power/
│   │       ├── parameter-caps.test.ts
│   │       ├── power-service.test.ts
│   │       └── science.test.ts
│   ├── smoke/
│   ├── tools/
│   ├── fake-power.ts
│   ├── markdown-text.ts
│   └── sized-refusal.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
