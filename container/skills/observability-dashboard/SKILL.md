---
name: observability-dashboard
description: >
  Renders observability HTML dashboards. Reads KPI snapshots, active
  deployments, and bleeding events. Generates main.html (long-term health)
  and competition.html (tactical real-time) in observability/dashboards/.
  Trigger on: "dashboard", "render dashboard", "observability dashboard",
  "show dashboard", "generate dashboard".
---

# Observability Dashboard Renderer

Generates two static HTML dashboards from accumulated observability data.

- **Main dashboard**: Long-term system health review with KPI trends,
  knowledge accumulation, diagnostic drill-downs, and reflection journal.
- **Competition dashboard**: Tactical real-time operational tool with
  action items, active strategies, bleeding events, and detection confidence.

Both dashboards are self-contained HTML files with inline CSS/JS/SVG.
No external dependencies. Readable without internet access.

## Dependencies

| Tool / Skill | Purpose |
|--------------|---------|
| Bash | Execute Python dashboard renderer |
| Read | Verify output files |

## Files Read

| Path | Purpose |
|------|---------|
| `knowledge/observability/kpi-snapshots.jsonl` | 90-day KPI history |
| `knowledge/observability/bleeding-events.jsonl` | Active bleeding events |
| `knowledge/observability/reflection-journal.jsonl` | Recent reflections |
| `auto-mode/deployments.json` | Active strategies for competition view |
| `auto-mode/market-prior.json` | Regime fit computation |
| `knowledge/discoveries.jsonl` | Knowledge store counts |
| `knowledge/anti-patterns.jsonl` | Knowledge store counts |
| `knowledge/graduations.jsonl` | Knowledge store counts |

## Files Written

| Path | Purpose |
|------|---------|
| `observability/dashboards/main.html` | Main dashboard |
| `observability/dashboards/competition.html` | Competition dashboard |

## Algorithm

### Step 1: Render dashboards

```bash
python /app/kata/observability/render_dashboards.py \
  --workspace "$(pwd)"
```

In competition mode (when `setup/observability-config.json` has
`competition_mode: true`), add `--competition-only` for faster refresh.

### Step 2: Verify output

```bash
ls -la observability/dashboards/main.html observability/dashboards/competition.html
```

Both files should exist and be > 1KB. If either is missing, report the error.

### Step 3: Report

```
Dashboards rendered:
  - observability/dashboards/main.html (Xkb)
  - observability/dashboards/competition.html (Xkb)
```

## Dashboard Sections

### Main Dashboard (6 sections)
1. **Headline**: LVEQ value, 90-day trend, direction indicator
2. **Four KPI Tiles**: RCCE, BDL, MTTD, LVEQ with sparklines and status colors
3. **Knowledge Accumulation**: Discovery/anti-pattern counts, reuse rate
4. **Trends**: Sparklines from KPI history
5. **Diagnostic Drill-Down**: Collapsible sections for divergence, regime breakdown, throughput, correlation
6. **Reflection Journal**: Last 7 daily reflections summarized

### Competition Dashboard (5 sections)
1. **Action Items**: Priority-ordered recommendations (Decision Rules R1-R5)
2. **Today's Vitals**: RCCE, active slots, missed bleeders, LVEQ, detection confidence
3. **Currently Bleeding**: Strategies in anti-regime with elapsed time
4. **Active Strategies**: Table with regime fit, P&L, slot state
5. **Generated timestamp**: Auto-refresh indicator
