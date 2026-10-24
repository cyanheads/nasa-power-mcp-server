<div align="center">
  <h1>@cyanheads/nasa-power-mcp-server</h1>
  <p><b>Query NASA POWER solar, wind, building, and agroclimatology data via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/nasa-power-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/nasa-power-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nasa-power-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/nasa-power-mcp-server/releases/latest/download/nasa-power-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=nasa-power-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbmFzYS1wb3dlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22nasa-power-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnasa-power-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://nasa-power.caseyjhand.com/mcp](https://nasa-power.caseyjhand.com/mcp)

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

- `latitude` / `longitude` and `temporalResolution`: `hourly` and `daily` take an inclusive `startDate` / `endDate`, `monthly` takes `startYear` / `endYear`. `selection` is a named `preset` (default `solar_pv`) or explicit `parameters`, at most 15 effective codes hourly and 20 otherwise, corrections included.
- `community` (`RE`, `SB`, `AG`; default `RE`), `units` (`metric`, `imperial`) and `timeStandard` (`LST`, `UTC`). Optional `siteElevation` adds `PSC`; paired `windElevation` (10–300 meters) and `windSurface` add `WSC`. Use `nasa_power_list_reference` topic `wind_surfaces` for all 17 canonical NASA aliases, including `airportgrass`, `airportice` and `vegtype_1`; vegetation underscores are retained.
- Returns `metadata`, `parameters`, `expansions`, `omittedParameters`, `summaries`, `rows`, an exact `rowCount` and `dataset` (null unless staged). Optional `canvas_id` reuses a canvas when staging is needed.

---

### `nasa_power_get_climatology` <sub>tool</sub>

- Point coordinates with the same selection and corrections; optional `startYear` and `endYear` together, otherwise the source product range. No `temporalResolution` input.
- Small profiles remain inline; larger profiles return a bounded preview and complete `dataset` handle. Pass optional `canvas_id` to reuse an existing workspace. Without DuckDB, narrow oversized selections for inline output. `SI_EF_TILTED_SURFACE` and the distinct `SI_TILTED_AVG`, `SI_TILTED_MIN`, `SI_TILTED_MAX` groups list only their actually returned members, numeric angles and N/S orientation text included, in `expansions`. A group is omitted only when none of its members return.

---

### `nasa_power_get_region` <sub>tool</sub>

- One `parameter` over ordered `latitudeMin` / `latitudeMax` and `longitudeMin` / `longitudeMax`, each axis spanning 2–10 degrees (`invalid_region` otherwise); split antimeridian regions into separate calls. `temporalResolution` is `daily`, `monthly` or `climatology`; point corrections are unsupported.
- Daily regions require date bounds and monthly regions require year bounds. Regional climatology accepts no year fields and reports the source's precomputed period; use `nasa_power_get_climatology` for a custom point year window.
- Returns cell-tagged `rows`, `cellCount` and per-period `summaries` with equal-weight cell `min` / `mean` / `max`, not area-weighted. Optional `canvas_id` reuses a canvas for staging.
- Oversized summary envelopes return `summaryDataset` with all cross-cell summaries, exact `summaryCount` and a whole-record inline preview. Query the table in `summaryIndex` order; SQL `units: null` restores an omitted source unit. Observations and summaries register together and retain linked provenance.

---

### `nasa_power_compare_locations` <sub>tool</sub>

- 2–10 `locations`, each with coordinates and a `label` of 1–120 characters, sharing one selection, corrections and window. `temporalResolution` defaults to `climatology`; `hourly`, `daily` and `monthly` also work.
- Returns successful `locations` with per-site provenance, location-tagged `rows`, annual and calendar-season `summaries`, and `failed` entries with `partial: true` when some sites fail; all-site failure returns `all_locations_failed`. `possibleSharedGridCell` flags sites that may share a grid cell.
- Optional `sort` (`parameter`, `direction` `asc` / `desc`) orders by a selected numeric parameter with known identical units. Optional `canvas_id` reuses a canvas for staging.
- When summaries exceed the response budget, `summaryDatasets.buckets` and `summaryDatasets.locations` point to complete SQL tables; inline summaries become whole-record previews and each location includes `summaryCount`. Query in `summaryIndex` order; the location-summary table includes `locationId`. SQL `units: null` represents an omitted source unit, not a known unit.

---

### `nasa_power_search_parameters` <sub>tool</sub>

- `community` (default `RE`), `temporalResolution` (default `daily`), optional `filter` (up to 256 characters), `offset` and positive integer `limit` (default 20, effective cap 100 with a notice when capped).
- Every case-insensitive `filter` token must match a code, name or definition across the complete dictionary before sorted pagination; a blank filter browses it. `entries`, `total`, `hasMore` and `truncated` describe the page.

---

### `nasa_power_list_reference` <sub>tool</sub>

- `topic`: `presets` (default), `communities`, `coverage`, `missing_data`, `wind_surfaces` or `dataframes`.
- Returns typed `entries`, `guidance`, `documentationUrls` and `verifiedOn`. Presets are `solar_pv`, `wind_turbine`, `building_hvac`, `agroclimatology` and `water_balance`; `building_hvac` is unavailable hourly. `agroclimatology` adds `T2M_MAX` and `T2M_MIN` outside hourly resolution; monthly/climatology extremes remain source aggregates, without reconstructed daily records or calculated growing degree days.

---

### `nasa_power_dataframe_describe` <sub>tool</sub>

- Required `canvas_id` from a producing response; optional `table` limits inspection to one table.
- Returns canvas and table expiry, SQL columns with source units, and original scientific `provenance`. Only tables in the supplied canvas are visible.

---

### `nasa_power_dataframe_query` <sub>tool</sub>

- Required `canvas_id` and one read-only SELECT in `sql` (up to 16,384 characters); positive integer `rowLimit` defaults to 100 and is capped at 1,000, with an effective-cap notice for larger requests. Files, writes and system catalogs are denied.
- Returns `columns`, `rows`, `rowCount`, `shownCount`, `truncated` and `countSemantics` (`exact` or `materialized_prefix`). SQL has a 10-second deadline; the structured and rendered outputs each must fit 40,000 characters.
- SQL mistakes retain bounded identifiers or conversion values with recovery guidance. Operational failures use generic messages; engine paths and native causes are excluded.

---

### `nasa_power_dataframe_drop` <sub>tool</sub>

- Required `canvas_id` and exact `table`; enabled only by `NASA_POWER_DATAFRAME_DROP_ENABLED=true`.
- Returns `dropped: false` for an absent table while other tables keep the canvas alive. Removing the final table also retires its canvas and frees its slot; subsequent describe, query or drop calls return `canvas_not_found`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

POWER-specific:

- Historical gridded observations, rather than site measurements or forecasts. Meteorological coverage starts in 1981, solar in 1984 and hourly in 2001; source configuration and publication latency further constrain availability.
- One active upstream request, starts at least two seconds apart, bounded retries and a 55-second overall call deadline. NASA publishes no numeric request allowance. References cache for 24 hours and observations for 10 minutes.
- Source fill values become `null`; zero remains a measurement. Monthly annual keys and climatology `ANN` remain distinct from monthly observations. LST labels have no UTC offset.
- `T_ZONES` and `TM_ZONES` retain numeric climate-zone codes with `valueKind: categorical`, including in SQL column metadata. They have no arithmetic summaries or comparison sort metrics; explicit numeric sorting by either is rejected.

Agent-friendly output:

- Scientific provenance — source API version, dataset identifiers, endpoint and access time accompany results; preserve returned units and attribute NASA POWER.
- Explicit gaps — `omittedParameters` distinguishes an absent series from fill values; arithmetic observation means and calendar-season buckets are not climate normals, annual yields or water balances.
- Complete datasets — inline outputs each fit 40,000 characters. Larger datasets stage all rows with a preview of at most 20 rows and a `dataset` handle; unsupported or oversized requests fail with narrowing guidance instead of returning a capped source prefix.

Staging requires DuckDB and supports at most 250,000 rows, 64 parameter columns and 32 MiB of serialized rows per dataset. Canvases are process-local capabilities: pass the returned token explicitly and route later calls to the same process. Tables expire after 30 minutes with eight tables per canvas. Defaults are one idle hour and six absolute hours per canvas, four canvases per tenant, eight per process, and 256 MiB engine memory per canvas. Operators can size canvas capacity, memory and lifetime below; engine memory does not bound total RSS or temporary disk.

## Getting started

### Public Hosted Instance

A public instance is available at `https://nasa-power.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "nasa-power-mcp-server": {
      "type": "streamable-http",
      "url": "https://nasa-power.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- npm and Docker install native DuckDB dependencies normally on supported platforms, and staging and SQL are on by default. Set `CANVAS_PROVIDER_TYPE=none` to keep every result inline.
- The portable Claude Desktop MCPB bundle fixes `CANVAS_PROVIDER_TYPE=none` and supports inline results. Narrow an oversized request or use npm/Docker for analytics.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/nasa-power-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd nasa-power-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to change transport, logging or canvas settings
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `NASA_POWER_DATAFRAME_DROP_ENABLED` | Expose explicit staged-table removal. | `false` |
| `CANVAS_PROVIDER_TYPE` | `duckdb` stages large results for SQL on npm/Docker; `none` keeps results inline. MCPB fixes `none`. | `duckdb` |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | Per-canvas engine memory, integer ≥64 MiB; not total RSS or temporary disk. | `256` |
| `CANVAS_MAX_CANVASES_PER_TENANT` | Positive tenant canvas cap; auth-none callers share one tenant. | `4` |
| `NASA_POWER_MAX_CANVASES_PER_PROCESS` | Positive process canvas cap, including pending and failed cleanup reservations. | `8` |
| `CANVAS_TTL_MS` | Positive sliding canvas lifetime in milliseconds. | `3600000` |
| `CANVAS_ABSOLUTE_CAP_MS` | Absolute canvas lifetime in milliseconds, at least the sliding TTL. | `21600000` |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP bind address and port. | `127.0.0.1` / `3010` |
| `MCP_AUTH_MODE` | `none`, `jwt` or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Minimum log level. | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

Unset, blank and whole-value placeholder settings retain these defaults. Invalid sizing fails startup. Byte budgets, table limits and producer concurrency remain fixed independently of operator canvas sizing. See [`.env.example`](./.env.example) for optional transport, authentication, storage, logging and telemetry settings.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t nasa-power-mcp-server .
docker run --rm -p 127.0.0.1:3010:3010 nasa-power-mcp-server
```

The image defaults to HTTP on port 3010 in stateless session mode and logs to `/var/log/nasa-power-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them. For a client outside loopback, configure authentication and TLS at the deployment boundary.

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

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.signal` for cancellation
- Register new tools in the `createApp()` array in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields, and preserve source units and annual-period distinctions
- `content[]` and `structuredContent` carry the same complete data

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
