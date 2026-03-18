---
name: add-strategydna-mcp
description: >
  Add StrategyDNA MCP integration — genome management toolkit for declarative
  trading strategies. 8 tools for creating, verifying, diffing, forking, and
  compiling .sdna genomes into FreqTrade IStrategy Python code.
---

# Add StrategyDNA MCP Integration

Installs the [strategydna-core](https://github.com/adaptiveX-gh/strategydna-core.git)
Python MCP server in the agent container. Provides 8 tools for the
**Create → Verify → Fork → Compile** genome lifecycle.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -d container/strategydna-core && echo "Already cloned" || echo "Not cloned"
grep -q "strategydna" container/Dockerfile && echo "Dockerfile updated" || echo "Not in Dockerfile"
```

If both are true, skip to Phase 3 (Configure).

### Prerequisites

- **Git access** to `https://github.com/adaptiveX-gh/strategydna-core.git`
- **freqtrade-mcp** skill already installed (for the compilation → backtesting workflow)

## Phase 2: Apply Code Changes

### 2a. Clone the package

```bash
cd container
git clone https://github.com/adaptiveX-gh/strategydna-core.git strategydna-core
cd ..
```

### 2b. Update the Dockerfile

In `container/Dockerfile`, add after the freqtrade-mcp install:

```dockerfile
# Install strategydna-core genome toolkit
COPY strategydna-core/ /app/strategydna-core/
RUN pip install --break-system-packages /app/strategydna-core[mcp]
```

### 2c. Register in agent-runner index

In `container/agent-runner/src/index.ts`:

**Add to `allowedTools`** (after `'mcp__freqtrade__*'`):
```typescript
'mcp__strategydna__*',
```

**Add to `mcpServers`** (after the `freqtrade` entry):
```typescript
strategydna: {
  command: 'python3',
  args: ['-m', 'strategydna'],
  env: {},
},
```

### 2d. Copy updated agent-runner source to per-group dirs

```bash
# Copy the updated index.ts to all group-specific agent-runner-src dirs
for dir in container/groups/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/index.ts" 2>/dev/null || true
done
```

### 2e. Create agent-facing SKILL.md

Copy `container/skills/strategydna-mcp/SKILL.md` (already created by this skill).

### 2f. Rebuild

```bash
npm run build && ./container/build.sh
```

## Phase 3: Configure

No environment variables required. The StrategyDNA MCP server is self-contained.

Optionally restart the service:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.service
# or Linux
sudo systemctl restart nanoclaw
```

## Phase 4: Verify

### Test via agent chat

1. **List templates**: "What genome templates are available?"
   - Should return: blank, rsi_mean_reversion

2. **Create and compile**: "Create an RSI mean reversion genome and compile it to FreqTrade"
   - Should return: genome JSON + compiled Python strategy code

3. **Verify**: "Verify the hash of this genome: [paste .sdna content]"
   - Should return: valid/invalid with hash

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i strategydna
```
