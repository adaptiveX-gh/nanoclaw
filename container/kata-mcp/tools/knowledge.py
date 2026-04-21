# tools/knowledge.py — kata_read_knowledge, kata_record_experiment
import datetime
import difflib
import json
import os
import re
import shutil
import sys
from pathlib import Path

from mcp.server.fastmcp import Context
from server import mcp, budget_check

# Ensure kata/lib is importable
_KATA_DIR = Path(os.environ.get("KATA_SOURCE_DIR", "/app/kata"))
if str(_KATA_DIR) not in sys.path:
    sys.path.insert(0, str(_KATA_DIR))

from lib.knowledge import (  # type: ignore
    append_anti_pattern,
    append_discovery,
    aggregate_patterns,
    load_knowledge_context,
    record_graduation,
)
from lib.evolution import (  # type: ignore
    generate_event_id,
    log_evolution_event,
)


@mcp.tool(name="kata_read_knowledge")
async def kata_read_knowledge(archetype: str, ctx: Context) -> str:
    """Load cross-race knowledge for an archetype.

    Returns discoveries, anti-patterns, graduated sequences, maturity-aware
    playbook, and knowledge velocity. Use this to learn from previous races
    before making changes.

    Args:
        archetype: Strategy archetype (e.g. MEAN_REVERSION, TREND_MOMENTUM).
    """
    budget_warning = budget_check(ctx)

    knowledge_dir = ctx.request_context.lifespan_context["knowledge_dir"]

    knowledge_text = load_knowledge_context(knowledge_dir, archetype, n=20)

    if not knowledge_text:
        knowledge_text = f"(No knowledge available for archetype '{archetype}' yet.)"

    if budget_warning:
        knowledge_text += f"\n\n{budget_warning}"

    return knowledge_text


# ---------------------------------------------------------------------------
# Discipline enforcement helpers
# ---------------------------------------------------------------------------

def _count_logical_changes(before: str, after: str) -> tuple[int, list[str]]:
    """Count logical changes between two versions of agent.py.

    Returns (change_count, descriptions).
    A logical change is:
    - A function body modified (counted per function)
    - A class-level attribute added/removed/changed
    - An import added/removed
    """
    if before == after:
        return 0, ["no changes"]

    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)

    diff = list(difflib.unified_diff(before_lines, after_lines, n=0))
    if not diff:
        return 0, ["no changes"]

    # Track which functions were modified
    modified_functions = set()
    modified_imports = 0
    current_hunk_adds = []
    current_hunk_removes = []
    current_hunk_start = 1  # 1-based line number from hunk header

    for line in diff:
        if line.startswith("@@"):
            # Process previous hunk
            _classify_hunk(current_hunk_start, current_hunk_removes,
                           current_hunk_adds, modified_functions, before_lines)
            current_hunk_adds = []
            current_hunk_removes = []
            # Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
            hunk_match = re.match(r"@@ -(\d+)", line)
            current_hunk_start = int(hunk_match.group(1)) if hunk_match else 1
        elif line.startswith("-") and not line.startswith("---"):
            stripped = line[1:].strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                modified_imports += 1
            current_hunk_removes.append(line[1:])
        elif line.startswith("+") and not line.startswith("+++"):
            stripped = line[1:].strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                modified_imports += 1
            current_hunk_adds.append(line[1:])

    # Process last hunk
    _classify_hunk(current_hunk_start, current_hunk_removes,
                   current_hunk_adds, modified_functions, before_lines)

    descriptions = []
    if modified_functions:
        descriptions.append(f"Modified functions: {', '.join(sorted(modified_functions))}")
    if modified_imports:
        descriptions.append(f"Changed {modified_imports} import(s)")

    # Count: each modified function = 1, import block = 1 if any changed
    change_count = len(modified_functions) + (1 if modified_imports > 0 else 0)

    # If only 1 function touched and imports changed to support it, that's still 1 logical change
    if len(modified_functions) == 1 and modified_imports > 0:
        change_count = 1
        descriptions = [f"Modified {list(modified_functions)[0]} (with import change)"]

    if change_count == 0:
        # Whitespace or comment-only changes
        change_count = 1
        descriptions = ["Minor change (whitespace/comments)"]

    return change_count, descriptions


def _classify_hunk(hunk_start_line: int, removes: list[str], adds: list[str],
                   modified_functions: set, source_lines: list[str]):
    """Classify a diff hunk by line number — which function does it belong to?"""
    if not removes and not adds:
        return

    func_name = _find_function_at_line(hunk_start_line, source_lines)
    if func_name:
        modified_functions.add(func_name)
        return

    # Check if it's a class-level attribute
    all_changed = removes + adds
    for line in all_changed:
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            if re.match(r"^\w+\s*=", stripped):
                modified_functions.add("class_attribute")
                return

    modified_functions.add("unknown_location")


def _find_function_at_line(line_num: int, source_lines: list[str]) -> str | None:
    """Find which def contains the given 1-based line number."""
    current_func = None
    for i, src_line in enumerate(source_lines, 1):
        stripped = src_line.strip()
        if stripped.startswith("def "):
            match = re.match(r"def\s+(\w+)", stripped)
            if match:
                current_func = match.group(1)
        if i >= line_num:
            return current_func
    return current_func


# ---------------------------------------------------------------------------
# State file writing
# ---------------------------------------------------------------------------

def _write_kata_state(ctx: Context, status: str, experiments: list,
                      best_score: float, current_score: float,
                      max_experiments: int, wf_results: dict | None = None,
                      graduate_path: str | None = None,
                      error: str | None = None,
                      kata_mode: str = "agent",
                      cumulative_tokens: int = 0):
    """Write kata-state.json atomically — same format as iterate_container.py."""
    import tempfile

    kata_state = ctx.request_context.lifespan_context["kata_state"]
    sharpe_trajectory = [e.get("score", 0) for e in experiments if e.get("score") is not None]

    state = {
        "status": status,
        "kata_mode": kata_mode,
        "experiments": len(experiments),
        "max_experiments": max_experiments,
        "current_score": round(current_score, 4),
        "best_score": round(best_score, 4),
        "sharpe_trajectory": [round(s, 4) for s in sharpe_trajectory],
        "cumulative_tokens": cumulative_tokens,
        "updated_at": datetime.datetime.now().isoformat(timespec="seconds"),
    }

    if wf_results:
        state["wf_pattern"] = wf_results.get("wf_pattern", "UNKNOWN")
        state["per_window_sharpe"] = wf_results.get("per_window_sharpe", [])
        state["dsr"] = wf_results.get("dsr", 0)
        state["pbo"] = wf_results.get("pbo", 1.0)

    if experiments:
        last = experiments[-1]
        state["last_experiment"] = {
            "num": last.get("num", 0),
            "change": last.get("change", ""),
            "kept": last.get("kept", "N/A"),
        }

    if graduate_path:
        state["graduate_path"] = graduate_path
    if error:
        state["error"] = error

    # Atomic write
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(kata_state.parent), suffix=".tmp"
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, str(kata_state))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@mcp.tool(name="kata_record_experiment")
async def kata_record_experiment(
    experiment_num: int,
    change: str,
    obstacle: str,
    score_before: float,
    score_after: float,
    kept: bool,
    ctx: Context,
    wf_pattern: str = "UNKNOWN",
    tier: str = "UNKNOWN",
    dsr: float = 0.0,
    pbo: float = 1.0,
) -> str:
    """Record experiment result to results.tsv, knowledge stores, and kata-state.json.

    ENFORCES DISCIPLINE: Before recording, diffs agent.py against the last
    snapshot. If more than one logical change was made (multiple functions
    modified, or >1 indicator added/removed), REJECTS the recording with
    an error describing what changed. The agent must revert to snapshot
    and make a single atomic edit.

    After recording, takes a new snapshot and resets the investigation budget.

    Args:
        experiment_num: Current experiment number (1-based).
        change: Brief description of the change made.
        obstacle: The obstacle being addressed.
        score_before: Score before this experiment.
        score_after: Score after this experiment.
        kept: Whether the change was kept (True) or reverted (False).
        wf_pattern: Walk-forward pattern (CONSISTENT/DEGRADING/ALTERNATING/SINGLE_SPIKE).
        tier: Score tier (POOR/FAIR/GOOD/EXCELLENT).
        dsr: Deflated Sharpe Ratio.
        pbo: Probability of Backtest Overfitting.
    """
    lc = ctx.request_context.lifespan_context
    agent_py = lc["agent_py"]
    snapshot = lc["snapshot"]
    results_tsv = lc["results_tsv"]
    knowledge_dir = lc["knowledge_dir"]
    gap_target = lc["gap_target"]

    try:
        gap = json.loads(gap_target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        gap = {}

    pair = os.environ.get("TARGET_PAIR") or gap.get("pair", "SOL/USDT:USDT")
    timeframe = os.environ.get("TARGET_TIMEFRAME") or gap.get("timeframe", "1h")
    archetype = gap.get("archetype", "unknown")

    # ---------------------------------------------------------------------------
    # DISCIPLINE ENFORCEMENT: Check atomic change constraint
    # ---------------------------------------------------------------------------
    if snapshot.exists() and agent_py.exists():
        snapshot_code = snapshot.read_text(encoding="utf-8")
        current_code = agent_py.read_text(encoding="utf-8")

        if snapshot_code != current_code:
            change_count, descriptions = _count_logical_changes(snapshot_code, current_code)

            if change_count > 1:
                return json.dumps({
                    "error": "DISCIPLINE VIOLATION: Multiple logical changes detected since last snapshot.",
                    "change_count": change_count,
                    "changes": descriptions,
                    "action_required": (
                        "Revert agent.py to snapshot (restore from agent.py.snapshot) "
                        "and make a SINGLE atomic edit. Only one function or one "
                        "parameter should change per experiment."
                    ),
                })

    # ---------------------------------------------------------------------------
    # Record to results.tsv
    # ---------------------------------------------------------------------------
    header = "# experiment\ttimestamp\tchange\tscore_before\tscore_after\tkept\twf_pattern\ttier\n"
    if not results_tsv.exists():
        results_tsv.write_text(header)

    ts = datetime.datetime.now().isoformat(timespec="seconds")
    sb = f"{score_before:.4f}" if score_before is not None else "N/A"
    row = f"{experiment_num}\t{ts}\t{change}\t{sb}\t{score_after:.4f}\t{kept}\t{wf_pattern}\t{tier}\n"
    with open(results_tsv, "a") as f:
        f.write(row)

    # ---------------------------------------------------------------------------
    # Save experiment artifacts
    # ---------------------------------------------------------------------------
    experiments_dir = lc["experiments_dir"]
    exp_dir = experiments_dir / f"exp_{experiment_num:03d}"
    exp_dir.mkdir(parents=True, exist_ok=True)

    if agent_py.exists():
        shutil.copy2(agent_py, exp_dir / "agent.py")

    reasoning = {
        "obstacle": obstacle,
        "change": change,
        "score_before": score_before,
        "score_after": score_after,
        "kept": kept,
    }
    (exp_dir / "reasoning.json").write_text(
        json.dumps(reasoning, indent=2), encoding="utf-8"
    )

    # ---------------------------------------------------------------------------
    # Record to knowledge stores
    # ---------------------------------------------------------------------------
    knowledge_entry = {
        "archetype": archetype,
        "pair": pair,
        "timeframe": timeframe,
        "obstacle": obstacle,
        "change": change,
        "score_before": round(score_before, 4),
        "score_after": round(score_after, 4),
        "delta": round(score_after - score_before, 4),
        "wf_pattern": wf_pattern,
    }

    if kept and score_after > score_before:
        append_discovery(knowledge_dir, knowledge_entry)
    elif not kept:
        append_anti_pattern(knowledge_dir, knowledge_entry)

    # ---------------------------------------------------------------------------
    # Evolution event
    # ---------------------------------------------------------------------------
    resource_id = f"{archetype}_{pair}_{timeframe}_exp{experiment_num}"
    event_id = generate_event_id(resource_id)

    operation = "commit" if kept else "rollback"
    log_evolution_event(
        knowledge_dir,
        event_id=event_id,
        resource_type="strategy",
        resource_id=resource_id,
        operation=operation,
        proposer="kata-agent",
        proposed_change=change,
        obstacle=obstacle,
        metrics_before={"score": score_before},
        metrics_after={"score": score_after, "dsr": dsr, "pbo": pbo},
        verdict="kept" if kept else "reverted",
    )

    # ---------------------------------------------------------------------------
    # Update snapshot (if keeping) or revert (if not)
    # ---------------------------------------------------------------------------
    if kept and agent_py.exists():
        shutil.copy2(agent_py, snapshot)
    elif not kept and snapshot.exists():
        shutil.copy2(snapshot, agent_py)

    # ---------------------------------------------------------------------------
    # Update kata-state.json
    # ---------------------------------------------------------------------------
    # Read existing experiments from results.tsv
    experiments_list = []
    if results_tsv.exists():
        for line in results_tsv.read_text().strip().split("\n"):
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) >= 6:
                experiments_list.append({
                    "num": int(parts[0]) if parts[0].isdigit() else 0,
                    "change": parts[2] if len(parts) > 2 else "",
                    "score": float(parts[4]) if len(parts) > 4 and parts[4] != "N/A" else 0.0,
                    "kept": parts[5] if len(parts) > 5 else "N/A",
                })

    best_score = max((e["score"] for e in experiments_list), default=0.0)
    max_experiments = int(os.environ.get("KATA_MAX_EXPERIMENTS", "15"))

    budget = lc["budget"]
    _write_kata_state(
        ctx,
        status="running",
        experiments=experiments_list,
        best_score=best_score,
        current_score=score_after if kept else score_before,
        max_experiments=max_experiments,
        kata_mode="agent",
        cumulative_tokens=budget.get("cumulative_tokens", 0),
    )

    # ---------------------------------------------------------------------------
    # Reset budget counter
    # ---------------------------------------------------------------------------
    budget["calls_since_last_record"] = 0
    budget["agent_py_edited"] = False

    return json.dumps({
        "recorded": True,
        "experiment": experiment_num,
        "change": change,
        "score_before": round(score_before, 4),
        "score_after": round(score_after, 4),
        "kept": kept,
        "knowledge": "discovery" if (kept and score_after > score_before) else ("anti_pattern" if not kept else "neutral"),
        "budget_reset": True,
    })
