# server.py — Shared FastMCP instance for Kata MCP
import os
from typing import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from mcp.server.fastmcp import FastMCP


@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[dict]:
    """Manage lifecycle and shared state for kata tools."""
    race_dir = Path(os.environ.get("KATA_RACE_DIR", "/workspace/race"))
    data_dir = os.environ.get("KATA_DATA_DIR", "/freqtrade/user_data/data")
    knowledge_dir = Path(os.environ.get("KATA_KNOWLEDGE_DIR", "/workspace/knowledge"))
    config_path = os.environ.get("KATA_CONFIG_PATH", "/freqtrade/user_data/config.json")

    context = {
        "race_dir": race_dir,
        "data_dir": data_dir,
        "knowledge_dir": knowledge_dir,
        "config_path": config_path,
        "agent_py": race_dir / "agent.py",
        "snapshot": race_dir / "agent.py.snapshot",
        "results_tsv": race_dir / "results.tsv",
        "kata_state": race_dir / "kata-state.json",
        "gap_target": race_dir / "gap_target.json",
        "graduates_dir": race_dir / "graduates",
        "experiments_dir": race_dir / "experiments",
        # Budget tracking — shared mutable state
        "budget": {
            "calls_since_last_record": 0,
            "max_investigation_calls": 5,
            "agent_py_edited": False,
        },
    }

    # Ensure directories exist
    context["graduates_dir"].mkdir(exist_ok=True)
    context["experiments_dir"].mkdir(exist_ok=True)
    knowledge_dir.mkdir(parents=True, exist_ok=True)

    try:
        yield context
    finally:
        server.info("Kata MCP server shutting down")


def budget_check(ctx) -> str | None:
    """Increment budget counter; return warning if exceeded.

    Call this from tool handlers that are NOT kata_record_experiment.
    kata_record_experiment resets the counter instead of incrementing.
    """
    budget = ctx.request_context.lifespan_context["budget"]
    budget["calls_since_last_record"] += 1
    if (
        budget["calls_since_last_record"] >= budget["max_investigation_calls"]
        and not budget["agent_py_edited"]
    ):
        return (
            "BUDGET WARNING: You have made "
            f"{budget['calls_since_last_record']} tool calls without editing "
            "agent.py. Make your edit or record a skip experiment."
        )
    return None


mcp = FastMCP(
    "KataMCP",
    dependencies=["pandas"],
    lifespan=app_lifespan,
    instructions=(
        "Kata MCP server — tools for improving FreqTrade trading strategies.\n"
        "\n"
        "RESPONSE FORMAT: All tools return valid JSON strings. Errors use "
        '{"error": "description"}.\n'
        "\n"
        "TOOLS:\n"
        "- kata_benchmark: Run 4-window walk-forward backtest\n"
        "- kata_smoke_test: Quick 30-day pre-filter\n"
        "- kata_check_graduation: Check if metrics pass graduation gates\n"
        "- kata_inspect_market: Check recent market conditions (ADX, ATR, regime)\n"
        "- kata_read_knowledge: Load cross-race knowledge for an archetype\n"
        "- kata_record_experiment: Record result + enforce atomic change discipline\n"
        "- kata_validate_strategy: AST-parse strategy code\n"
        "\n"
        "DISCIPLINE: kata_record_experiment enforces one-edit-between-benchmarks.\n"
        "If agent.py has multiple logical changes since the last snapshot, the\n"
        "recording is rejected.\n"
        "\n"
        "BUDGET: Every tool call increments the investigation counter. After 5\n"
        "tool calls without an edit to agent.py, a budget warning is returned."
    ),
)
