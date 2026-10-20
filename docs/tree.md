# nasa-power-mcp-server - Directory Structure

Generated on: 2026-10-20 02:18:48

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
│   │   │   └── types.ts
│   │   └── power/
│   │       ├── errors.ts
│   │       ├── index.ts
│   │       ├── normalize.ts
│   │       ├── power-service.ts
│   │       ├── presets.ts
│   │       ├── summarize.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config.test.ts
│   │   └── startup.test.ts
│   ├── fuzz/
│   ├── integration/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── nasa-power-dataframe-gating.test.ts
│   │       ├── nasa-power-dataframe.test.ts
│   │       ├── nasa-power-geographic-native.test.ts
│   │       ├── nasa-power-geographic.test.ts
│   │       ├── nasa-power-point-discovery.test.ts
│   │       ├── nasa-power-reference-config.test.ts
│   │       └── nasa-power-reference-size-recovery.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── canvas-service.test.ts
│   │   │   ├── failure-boundaries.test.ts
│   │   │   ├── fixture.ts
│   │   │   ├── format.test.ts
│   │   │   ├── request-lifetime.test.ts
│   │   │   └── response-budget.test.ts
│   │   └── power/
│   │       ├── parameter-caps.test.ts
│   │       ├── power-service.test.ts
│   │       └── science.test.ts
│   ├── smoke/
│   └── tools/
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
