<div align="center">
  <h1>@cyanheads/nasa-power-mcp-server</h1>
  <p><b>Query NASA POWER solar, wind, building, and agroclimatology data via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](https://github.com/cyanheads/nasa-power-mcp-server/releases) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![npm](https://img.shields.io/npm/v/@cyanheads/nasa-power-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nasa-power-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/nasa-power-mcp-server/releases/latest/download/nasa-power-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=nasa-power-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbmFzYS1wb3dlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22nasa-power-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnasa-power-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

[NASA POWER](https://power.larc.nasa.gov/) historical solar and meteorological observations for renewable energy, sustainable buildings and agroclimatology. Retrieve point time series and climatology, inspect native-grid regions, and compare labeled locations with source units and provenance. No NASA account or API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `nasa_power_get_timeseries` | Hourly, daily or monthly observations at one point |
| `nasa_power_get_climatology` | Monthly and annual point climatology, including tilted solar profiles |
| `nasa_power_get_region` | One parameter across a bounded native-grid region |
| `nasa_power_compare_locations` | Shared observations and seasonal summaries for 2–10 labeled points |
| `nasa_power_search_parameters` | Search the complete community/resolution parameter dictionary |
| `nasa_power_list_reference` | Presets, communities, coverage, missing values, wind surfaces and dataframe guidance |
| `nasa_power_dataframe_describe` | Inspect staged schemas, units, expiry and provenance |
| `nasa_power_dataframe_query` | Run bounded read-only SQL against an explicit canvas token |
| `nasa_power_dataframe_drop` | Opt-in removal of one named staged table |

Eight tools are enabled by default; `NASA_POWER_DATAFRAME_DROP_ENABLED=true` enables the ninth.

## Capability reference

### `nasa_power_get_timeseries` <sub>tool</sub>

- `latitude` / `longitude`, `temporalResolution` (`hourly`, `daily`, `monthly`), and an inclusive `startDate` / `endDate` or `startYear` / `endYear` window. `selection` chooses a named `preset` or explicit `parameters`: at most 15 effective hourly codes or 20 otherwise, including corrections.
- `community` (`RE`, `SB`, `AG`; default `RE`), `units` (`metric`, `imperial`) and `timeStandard` (`LST`, `UTC`) retain the returned source units and time labels. Optional `siteElevation` adds `PSC`; paired `windElevation` (10–300 meters) and `windSurface` (`grass`, `airportice`) add `WSC`.
- Returns `request`, `metadata`, `parameters`, `expansions`, `omittedParameters`, `summaries`, `rows`, exact `rowCount` and nullable `dataset`. Optional `canvas_id` reuses a workspace when staging is needed.

---

### `nasa_power_get_climatology` <sub>tool</sub>

- Point coordinates and the same parameter selection and corrections; optionally supply both `startYear` and `endYear`, otherwise use the source product range. No `temporalResolution` input is needed.
- Complete monthly and annual records remain inline; the climatology alias `SI_EF_TILTED_SURFACE` preserves returned numeric angles and orientation text through `expansions` and parameter metadata.

---

### `nasa_power_get_region` <sub>tool</sub>

- One `parameter`, ordered `latitudeMin` / `latitudeMax` and `longitudeMin` / `longitudeMax`, each spanning 2–10 degrees; split antimeridian regions. Supports daily, monthly and climatology windows, with common community, units and time settings.
- Returns cell-tagged observations, `cellCount` and per-period `cellSummaries`. Means weight each returned grid cell equally; point correction fields and hourly regions are unsupported. Optional `canvas_id` reuses a staging workspace.

---

### `nasa_power_compare_locations` <sub>tool</sub>

- 2–10 `locations`, each with coordinates and a `label` of 1–120 characters, plus shared selection, corrections and window. Defaults to climatology; supports hourly, daily and monthly comparisons too.
- Location-tagged rows, per-site metadata and summaries, seasonal buckets, `partial` and `failed` preserve operational failures alongside successes. `possibleSharedGridCell` flags nearby points without asserting exact grid identity.
- Optional `sort` takes a numeric selected `parameter` and `direction` (`asc`, `desc`); sorting requires known identical units. Optional `canvas_id` reuses a workspace. All-site failure returns `all_locations_failed`.

---

### `nasa_power_search_parameters` <sub>tool</sub>

- `community` (default `RE`), `temporalResolution` (default `daily`), optional `filter` (up to 256 characters), `offset` and `limit` 1–100 (default 20).
- Case-insensitive tokens filter the complete dictionary before sorted pagination; blank filter browses it. `entries`, `total`, `hasMore` and `truncated` describe the filtered page.

---

### `nasa_power_list_reference` <sub>tool</sub>

- `topic`: `presets` (default), `communities`, `coverage`, `missing_data`, `wind_surfaces` or `dataframes`.
- Returns typed `entries`, `guidance`, `documentationUrls` and `verifiedOn`. Presets are `solar_pv`, `wind_turbine`, `building_hvac`, `agroclimatology` and `water_balance`; `building_hvac` is unavailable hourly.

---

### `nasa_power_dataframe_describe` <sub>tool</sub>

- Required `canvas_id` from a producing response; optional `table` limits inspection to one table.
- Returns current canvas/table expiry, actual SQL columns with source units and original scientific `provenance`. Only tables in the supplied canvas are visible.

---

### `nasa_power_dataframe_query` <sub>tool</sub>

- Required `canvas_id` and one read-only SELECT in `sql` (up to 16,384 characters); `rowLimit` 1–1,000 (default 100). Joins and aggregates operate on tables shown by describe; files, writes and system catalogs are denied.
- Returns `columns`, `rows`, `rowCount`, `shownCount`, `truncated` and `countSemantics` (`exact` or `materialized_prefix`). SQL has a 10-second deadline; the complete structured and rendered outputs each must fit 40,000 characters.

---

### `nasa_power_dataframe_drop` <sub>tool</sub>

- Required `canvas_id` and exact `table`; enabled only by `NASA_POWER_DATAFRAME_DROP_ENABLED=true`.
- Returns `dropped: false` for an absent table in a live canvas. Expired or unknown canvases return `canvas_not_found`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

POWER-specific:

- Historical gridded observations, rather than site measurements or forecasts. Meteorological coverage starts in 1981, solar in 1984 and hourly in 2001; source configuration and publication latency further constrain availability.
- One active upstream request, starts at least two seconds apart, bounded retries and a 55-second overall call deadline. NASA publishes no numeric request allowance. References cache for 24 hours and observations for 10 minutes.
- Source fill values become `null`; zero remains a measurement. Monthly annual keys and climatology `ANN` remain distinct from monthly observations. LST labels have no UTC offset.

Agent-friendly output:

- Scientific provenance — source API version, dataset identifiers, endpoint and access time accompany results; preserve returned units and attribute NASA POWER.
- Explicit gaps — `omittedParameters` distinguishes an absent series from fill values; arithmetic observation means and calendar-season buckets are not climate normals, annual yields or water balances.
- Complete datasets — inline outputs each fit 40,000 characters. Larger datasets stage all rows with a preview of at most 20 rows and a `dataset` handle; unsupported or oversized requests fail with narrowing guidance instead of returning a capped source prefix.

Staging requires DuckDB and supports at most 250,000 rows, 64 parameter columns and 32 MiB of serialized rows per dataset. Canvases are process-local capabilities: pass the returned token explicitly and route later calls to the same process. Tables expire after 30 minutes, canvases after one idle hour with a six-hour absolute cap; limits are eight tables per canvas, four canvases per tenant and eight per process. Engine memory is 256 MiB per canvas, not a total RSS or temporary-disk quota.

## Getting started

### Self-Hosted / Local

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "nasa-power-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/nasa-power-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "nasa-power-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/nasa-power-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "nasa-power-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/nasa-power-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP from a local checkout:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher, or Node.js v24+.
- npm and Docker install native DuckDB dependencies normally on supported platforms. Set `CANVAS_PROVIDER_TYPE=duckdb` to enable staging and SQL; the default is `none`.
- The portable Claude Desktop MCPB bundle fixes `CANVAS_PROVIDER_TYPE=none` and supports inline results. Narrow an oversized request or use npm/Docker for analytics.

### Installation

```sh
git clone https://github.com/cyanheads/nasa-power-mcp-server.git
cd nasa-power-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `NASA_POWER_DATAFRAME_DROP_ENABLED` | Expose explicit staged-table removal. | `false` |
| `CANVAS_PROVIDER_TYPE` | `none` for inline results; `duckdb` for staging and SQL on npm/Docker. MCPB fixes `none`. | `none` |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | Fixed engine memory limit; not total RSS or temporary disk. | `256` |
| `CANVAS_MAX_CANVASES_PER_TENANT` | Fixed tenant canvas cap. | `4` |
| `CANVAS_TTL_MS` | Fixed sliding canvas lifetime. | `3600000` |
| `CANVAS_ABSOLUTE_CAP_MS` | Fixed absolute canvas lifetime. | `21600000` |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP bind address and port. | `127.0.0.1` / `3010` |
| `MCP_AUTH_MODE` | `none`, `jwt` or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Minimum log level. | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

DuckDB startup rejects changes to the four fixed canvas settings. See [`.env.example`](./.env.example) for optional transport, authentication, storage, logging and telemetry settings.

## Running the server

### Local development

```sh
bun run rebuild
bun run start:stdio   # or start:http
bun run devcheck
bun run test
```

### Docker

```sh
docker build -t nasa-power-mcp-server .
docker run --rm -p 127.0.0.1:3010:3010 -e CANVAS_PROVIDER_TYPE=duckdb nasa-power-mcp-server
```

The image defaults to HTTP on port 3010. For a client outside loopback, configure authentication and TLS at the deployment boundary.

## Project structure

| Path | Purpose |
|:---|:---|
| `src/index.ts` | Nine tool registrations, bounded canvas setup and service shutdown |
| `src/config` | Workload limits and server-specific environment parsing |
| `src/mcp-server/tools/definitions` | Tool contracts and comparison orchestration |
| `src/services/power` | Paced NASA client, normalization, presets and scientific summaries |
| `src/services/canvas` | Explicit-token staging, SQL, provenance and admission limits |
| `scripts` | Build, validation, packaging and release tooling |
| `tests` | Offline contracts and native integration tests |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for architectural rules.

- Handlers throw, framework catches; use `ctx.log` and `ctx.state`.
- Register tools in the `createApp()` array in `src/index.ts`.
- Validate NASA responses before normalization; preserve sparse fields, source units and annual-period distinctions.
- `content[]` and `structuredContent` carry the same complete data.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
