---
name: add-tds
description: >
  Add Trading Data Store (TDS) integration — record paper trades, signals,
  backtest results, and strategy events to an append-only, hash-chain-verified
  event ledger. Supports local Docker Compose or remote cloud TDS instances.
---

# Add TDS Integration

Installs a TypeScript MCP server that wraps the nanoclaw-tds REST API.
Provides 13 tools for agent management, event recording, competitions, and
system health.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f container/agent-runner/src/tds-mcp-stdio.ts && echo "Already exists" || echo "Not installed"
grep -q "mcp__tds__" container/agent-runner/src/index.ts && echo "Registered" || echo "Not registered"
```

If both are true, skip to Phase 3 (Configure).

### Prerequisites

- **nanoclaw-tds** running (local via `docker-compose up` or remote cloud instance)
- **API key** with `agent` role (created via TDS admin CLI or API)
- **Agent UUID** registered in TDS (via `POST /api/v1/agents`)

## Phase 2: Apply Code Changes

### 2a. Create the MCP server

Create `container/agent-runner/src/tds-mcp-stdio.ts` — TypeScript MCP server
using `McpServer` + `StdioServerTransport` (same pattern as `ipc-mcp-stdio.ts`).

13 tools:
- **Agent:** `tds_register_agent`, `tds_list_agents`, `tds_get_agent`
- **Events:** `tds_record_event`, `tds_record_trade`, `tds_record_signal`, `tds_query_events`, `tds_get_event`
- **Competition:** `tds_list_competitions`, `tds_get_competition`, `tds_get_standings`
- **System:** `tds_health`, `tds_verify_integrity`

Reads `TDS_URL`, `TDS_API_KEY`, `TDS_AGENT_ID` from `process.env`.
Logs to stderr with `[TDS]` prefix.

### 2b. Register in agent-runner index

In `container/agent-runner/src/index.ts`:

**Add to `allowedTools`** (after `'mcp__freqtrade__*'`):
```typescript
'mcp__tds__*',
```

**Add to `mcpServers`** (after the `freqtrade` entry):
```typescript
tds: {
  command: 'node',
  args: [path.join(path.dirname(mcpServerPath), 'tds-mcp-stdio.js')],
  env: {
    TDS_URL: process.env.TDS_URL || '',
    TDS_API_KEY: process.env.TDS_API_KEY || '',
    TDS_AGENT_ID: process.env.TDS_AGENT_ID || '',
  },
},
```

### 2c. Forward env vars in container-runner

In `src/container-runner.ts`, add after the Freqtrade env var block in
`buildContainerArgs`:

```typescript
const tdsKeys = ['TDS_URL', 'TDS_API_KEY', 'TDS_AGENT_ID'];
const tdsEnv = readEnvFile(tdsKeys);
for (const key of tdsKeys) {
  const val = process.env[key] || tdsEnv[key];
  if (val) args.push('-e', `${key}=${val}`);
}
```

Also add `[TDS]` log surfacing in the stderr handler:

```typescript
if (line.includes('[FREQTRADE]') || line.includes('[TDS]')) {
```

### 2d. Create the agent-facing skill doc

Create `container/skills/tds/SKILL.md` (auto-synced by container-runner).

### 2e. Copy to per-group agent-runner source

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
  cp container/agent-runner/src/tds-mcp-stdio.ts "$dir/"
done
```

### 2f. Build

```bash
npm run build
./container/build.sh
```

Both builds must complete without errors.

## Phase 3: Configure

### Set environment variables

Add to `.env`:

```
# Trading Data Store (paper trade recording)
TDS_URL=http://host.docker.internal:3100
TDS_API_KEY=your_agent_api_key
TDS_AGENT_ID=your_agent_uuid
```

**Notes:**
- For local TDS (Docker Compose), use `http://host.docker.internal:3100`
  since `localhost` inside the container refers to the container itself
- For remote cloud TDS, use the full URL (e.g. `https://tds.example.com`)
- `TDS_AGENT_ID` is the UUID returned by `POST /api/v1/agents` — register
  your agent first, then set this value

### Restart the service

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via chat

Ask the agent:
> "Check the TDS health"

Should call `tds_health` and return `{ status: "ok", db: "connected" }`.

> "Record a paper trade: opened long BTC/USDT at $95,000 with $100 stake"

Should call `tds_record_trade` and return the event record.

> "Show me my recent trade events"

Should call `tds_query_events` with `object_type=trade`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i tds
```

## Troubleshooting

### "TDS_URL not configured"

Set `TDS_URL` in `.env` to your TDS instance URL.

### "TDS 401: Unauthorized"

Check `TDS_API_KEY` in `.env` matches a valid API key in TDS.

### "agent_id required"

Set `TDS_AGENT_ID` in `.env` or register an agent first with `tds_register_agent`.

### MCP tools not available

Check `mcp__tds__*` in `allowedTools` in the agent-runner index.ts.

### Connection refused

If TDS is running locally, use `http://host.docker.internal:3100` (not
`http://localhost:3100`) since the agent runs inside a Docker container.
