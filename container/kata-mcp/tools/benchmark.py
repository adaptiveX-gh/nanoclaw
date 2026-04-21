# tools/benchmark.py — kata_benchmark and kata_smoke_test
import json
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import Context
from server import mcp, budget_check

# Ensure kata/lib is importable — mounted at /app/kata in container
_KATA_DIR = Path(os.environ.get("KATA_SOURCE_DIR", "/app/kata"))
if str(_KATA_DIR) not in sys.path:
    sys.path.insert(0, str(_KATA_DIR))

from wf_benchmark import run_walk_forward, smoke_test  # type: ignore
from lib.metrics import classify_walkforward_pattern  # type: ignore


@mcp.tool(name="kata_benchmark")
async def kata_benchmark(ctx: Context) -> str:
    """Run 4-window walk-forward backtest on agent.py.

    Returns per-window Sharpe, trades, win%, P&L, exit analysis, regime
    breakdown, worst trades, DSR, PBO, favorable_sharpe score, wf_pattern,
    composite_score, robustness_score, and tier.

    This is the primary measurement tool. Each call takes 30-120 seconds.
    Use kata_smoke_test first for quick pre-filtering.
    """
    budget_warning = budget_check(ctx)

    lc = ctx.request_context.lifespan_context
    agent_py = lc["agent_py"]
    data_dir = lc["data_dir"]
    config_path = lc["config_path"]
    race_dir = lc["race_dir"]

    # Read pair/timeframe from gap_target.json
    gap_target = lc["gap_target"]
    try:
        gap = json.loads(gap_target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        gap = {}

    pair = os.environ.get("TARGET_PAIR") or gap.get("pair", "SOL/USDT:USDT")
    timeframe = os.environ.get("TARGET_TIMEFRAME") or gap.get("timeframe", "1h")

    # Count experiments for DSR calculation
    results_tsv = lc["results_tsv"]
    experiment_count = 1
    if results_tsv.exists():
        lines = [l for l in results_tsv.read_text().strip().split("\n")
                 if l.strip() and not l.startswith("#")]
        experiment_count = len(lines) + 1

    output_dir = str(race_dir / "logs")
    try:
        wf_results = run_walk_forward(
            strategy_path=str(agent_py),
            pair=pair,
            timeframe=timeframe,
            data_dir=data_dir,
            output_dir=output_dir,
            config_path=config_path,
            experiment_count=experiment_count,
        )
    except Exception as e:
        return json.dumps({"error": f"Benchmark failed: {e}"})

    if wf_results is None:
        return json.dumps({"error": "Benchmark produced no results"})

    if wf_results.get("env_error"):
        return json.dumps({"error": f"Environment error: {wf_results['env_error']}"})

    # Compute score the same way as iterate_container.py
    sharpes = wf_results.get("per_window_sharpe", [0, 0, 0, 0])
    positive = [s for s in sharpes if s > 0]
    if not positive:
        score = 0.0
    else:
        favorable = sum(positive) / len(positive)
        score = min(favorable / 1.0, 1.0)
        score = max(score, 0.0)

    trades = wf_results.get("per_window_trades", [0, 0, 0, 0])
    pos_trades = sum(trades[i] for i, s in enumerate(sharpes) if s > 0)
    if pos_trades < 10:
        score = 0.0

    negative = [s for s in sharpes if s <= 0]
    if negative and (sum(negative) / len(negative)) < -1.0:
        score = 0.0

    # Strip trade_log to reduce response size
    result = {k: v for k, v in wf_results.items() if k != "trade_log"}
    result["favorable_sharpe_score"] = round(score, 4)
    result["total_oos_trades"] = sum(trades)

    if budget_warning:
        result["_budget_warning"] = budget_warning

    return json.dumps(result, default=str)


@mcp.tool(name="kata_smoke_test")
async def kata_smoke_test(ctx: Context) -> str:
    """Quick 30-day backtest on agent.py.

    Catches syntax errors, indicator crashes, and zero-trade scenarios
    before expensive walk-forward. Use this BEFORE kata_benchmark.

    Returns {passed, trades, sharpe, reason, elapsed}.
    """
    budget_warning = budget_check(ctx)

    lc = ctx.request_context.lifespan_context
    agent_py = lc["agent_py"]
    data_dir = lc["data_dir"]
    config_path = lc["config_path"]
    race_dir = lc["race_dir"]

    gap_target = lc["gap_target"]
    try:
        gap = json.loads(gap_target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        gap = {}

    pair = os.environ.get("TARGET_PAIR") or gap.get("pair", "SOL/USDT:USDT")
    timeframe = os.environ.get("TARGET_TIMEFRAME") or gap.get("timeframe", "1h")

    output_dir = str(race_dir / "logs" / "smoke")
    try:
        result = smoke_test(
            strategy_path=str(agent_py),
            pair=pair,
            timeframe=timeframe,
            data_dir=data_dir,
            output_dir=output_dir,
            config_path=config_path,
        )
    except Exception as e:
        return json.dumps({"error": f"Smoke test failed: {e}"})

    if result is None:
        result = {"error": "Smoke test returned no result"}

    if budget_warning:
        result["_budget_warning"] = budget_warning

    return json.dumps(result, default=str)
