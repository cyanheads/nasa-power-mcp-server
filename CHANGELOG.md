# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-10-29

Wide point selections that overflow the response budget on summaries alone are now served under DuckDB, or refused with canvas_required and re-sendable parameter-group calls without it, and region splits now work on coarse-grid parameters.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-10-28

Overlapping data calls are admitted or wait briefly instead of failing at once, canvas_required refusals size their re-sendable split, and GDD* and monthly hour-extreme codes POWER cannot serve are rejected before any request.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-10-28

Publishes the nasa-power-guide agent skill, served over MCP as skill://nasa-power-guide/SKILL.md, and moves to mcp-ts-core 0.13.18, which stops HTTP memory growth under Bun and keeps the framework build-only files out of the .mcpb bundle.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-10-24 · ⚠️ Breaking

Complete regional analysis and configurable canvases

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-10-20 · ⚠️ Breaking

Complete NASA POWER comparisons with bounded analytical outputs.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-10-19

NASA POWER observations and analytical datasets.
