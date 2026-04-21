# tools/inspect.py — kata_inspect_market, kata_check_graduation, kata_validate_strategy
import ast
import json
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import Context
from server import mcp, budget_check

# Ensure kata/lib is importable
_KATA_DIR = Path(os.environ.get("KATA_SOURCE_DIR", "/app/kata"))
if str(_KATA_DIR) not in sys.path:
    sys.path.insert(0, str(_KATA_DIR))


@mcp.tool(name="kata_inspect_market")
async def kata_inspect_market(
    ctx: Context,
    lookback_candles: int = 100,
) -> str:
    """Inspect recent market conditions for the target pair.

    Returns current ADX, ATR, EMA200 slope, BB width, regime classification,
    and basic OHLCV statistics. Use this when diagnosing why a strategy
    produces 0 trades — check if market conditions match the strategy's
    entry assumptions.

    Args:
        lookback_candles: Number of recent candles to analyze (default 100).
    """
    budget_warning = budget_check(ctx)

    lc = ctx.request_context.lifespan_context
    data_dir = lc["data_dir"]
    config_path = lc["config_path"]

    gap_target = lc["gap_target"]
    try:
        gap = json.loads(gap_target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        gap = {}

    pair = os.environ.get("TARGET_PAIR") or gap.get("pair", "SOL/USDT:USDT")
    timeframe = os.environ.get("TARGET_TIMEFRAME") or gap.get("timeframe", "1h")

    try:
        import pandas as pd
        from lib.regime import classify_regimes, compute_regime_summary  # type: ignore
    except ImportError as e:
        return json.dumps({"error": f"Missing dependency: {e}"})

    # Load OHLCV data from FreqTrade data directory
    # FreqTrade stores data as feather/json files
    pair_slug = pair.replace("/", "_").replace(":", "_")
    data_path = None

    # Try feather format first, then json
    for ext in [".feather", ".json"]:
        candidate = Path(data_dir) / f"{pair_slug}-{timeframe}{ext}"
        if candidate.exists():
            data_path = candidate
            break

    if data_path is None:
        # Try inside exchange subdirectory
        for subdir in Path(data_dir).iterdir():
            if subdir.is_dir():
                for ext in [".feather", ".json"]:
                    candidate = subdir / f"{pair_slug}-{timeframe}{ext}"
                    if candidate.exists():
                        data_path = candidate
                        break
            if data_path:
                break

    if data_path is None:
        return json.dumps({
            "error": f"No OHLCV data found for {pair} {timeframe} in {data_dir}",
            "searched_for": f"{pair_slug}-{timeframe}.*",
        })

    try:
        if str(data_path).endswith(".feather"):
            df = pd.read_feather(data_path)
        else:
            df = pd.read_json(data_path)
    except Exception as e:
        return json.dumps({"error": f"Failed to read data: {e}"})

    # Ensure standard column names
    col_map = {"open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}
    for col in col_map:
        if col not in df.columns:
            # Try capitalized
            cap = col.capitalize()
            if cap in df.columns:
                df = df.rename(columns={cap: col})

    # Take last N candles
    df = df.tail(lookback_candles).reset_index(drop=True)

    if len(df) < 20:
        return json.dumps({"error": f"Insufficient data: only {len(df)} candles"})

    # Compute key indicators
    close = df["close"]
    high = df["high"]
    low = df["low"]

    # ADX (14-period) — talib returns numpy arrays, use [-1] not .iloc[-1]
    try:
        import talib
        adx = talib.ADX(high.values, low.values, close.values, timeperiod=14)
        current_adx = float(adx[-1]) if not pd.isna(adx[-1]) else None
    except Exception:
        current_adx = None

    # ATR (14-period)
    try:
        atr = talib.ATR(high.values, low.values, close.values, timeperiod=14)
        current_atr = float(atr[-1]) if not pd.isna(atr[-1]) else None
        atr_pct = (current_atr / float(close.iloc[-1]) * 100) if current_atr is not None else None
    except Exception:
        current_atr = None
        atr_pct = None

    # EMA200
    try:
        ema200 = talib.EMA(close.values, timeperiod=min(200, len(close) - 1))
        ema200_current = float(ema200[-1]) if not pd.isna(ema200[-1]) else None
        ema200_prev = float(ema200[-10]) if len(ema200) >= 10 and not pd.isna(ema200[-10]) else None
        ema200_slope = (
            "rising" if ema200_current is not None and ema200_prev is not None and ema200_current > ema200_prev
            else ("falling" if ema200_current is not None and ema200_prev is not None else "unknown")
        )
    except Exception:
        ema200_current = None
        ema200_slope = "unknown"

    # Bollinger Band width (20, 2)
    try:
        upper, middle, lower = talib.BBANDS(close.values, timeperiod=20, nbdevup=2, nbdevdn=2)
        bb_width = float((upper[-1] - lower[-1]) / middle[-1] * 100) if not pd.isna(middle[-1]) else None
    except Exception:
        bb_width = None

    # RSI (14)
    try:
        rsi = talib.RSI(close.values, timeperiod=14)
        current_rsi = float(rsi[-1]) if not pd.isna(rsi[-1]) else None
    except Exception:
        current_rsi = None

    # Regime classification
    try:
        regimes = classify_regimes(df)
        regime_summary = compute_regime_summary(regimes)
        dominant_regime = max(regime_summary, key=regime_summary.get) if regime_summary else "UNKNOWN"
        current_regime = str(regimes.iloc[-1]) if len(regimes) > 0 else "UNKNOWN"
    except Exception:
        regime_summary = {}
        dominant_regime = "UNKNOWN"
        current_regime = "UNKNOWN"

    # Basic statistics
    last_close = float(close.iloc[-1])
    price_range = float(high.max() - low.min())
    avg_volume = float(df["volume"].mean())

    result = {
        "pair": pair,
        "timeframe": timeframe,
        "candles_analyzed": len(df),
        "last_close": round(last_close, 6),
        "price_range_pct": round(price_range / last_close * 100, 2),
        "avg_volume": round(avg_volume, 2),
        "indicators": {
            "adx_14": round(current_adx, 2) if current_adx else None,
            "atr_14": round(current_atr, 6) if current_atr else None,
            "atr_pct": round(atr_pct, 2) if atr_pct else None,
            "rsi_14": round(current_rsi, 2) if current_rsi else None,
            "ema200_slope": ema200_slope,
            "bb_width_pct": round(bb_width, 2) if bb_width else None,
        },
        "regime": {
            "current": current_regime,
            "dominant": dominant_regime,
            "distribution": {k: round(v, 3) for k, v in regime_summary.items()},
        },
        "interpretation": _interpret_market(current_adx, atr_pct, bb_width, current_regime),
    }

    if budget_warning:
        result["_budget_warning"] = budget_warning

    return json.dumps(result, default=str)


def _interpret_market(adx, atr_pct, bb_width, regime) -> str:
    """Generate plain-English market interpretation."""
    parts = []

    if adx is not None:
        if adx > 30:
            parts.append(f"Strong trend (ADX={adx:.0f}). Strategies with ADX < 25 filters will get 0 trades.")
        elif adx > 20:
            parts.append(f"Moderate trend (ADX={adx:.0f}).")
        else:
            parts.append(f"Weak/no trend (ADX={adx:.0f}). Trending strategies may struggle.")

    if atr_pct is not None:
        if atr_pct > 5:
            parts.append(f"High volatility (ATR={atr_pct:.1f}%). Wide stoploss needed.")
        elif atr_pct < 1:
            parts.append(f"Low volatility (ATR={atr_pct:.1f}%). Tight ranges, scalping-friendly.")

    if bb_width is not None:
        if bb_width < 2:
            parts.append("Bollinger Bands squeezed — breakout likely incoming.")
        elif bb_width > 8:
            parts.append("Wide Bollinger Bands — high volatility regime.")

    return " ".join(parts) if parts else "No strong signals in market structure."


@mcp.tool(name="kata_check_graduation")
async def kata_check_graduation(
    score: float,
    dsr: float,
    pbo: float,
    experiments: int,
    ctx: Context,
) -> str:
    """Check if current metrics pass all graduation gates.

    Args:
        score: Current favorable_sharpe score (0.0 to 1.0).
        dsr: Deflated Sharpe Ratio z-score.
        pbo: Probability of Backtest Overfitting (0.0 to 1.0).
        experiments: Number of experiments completed so far.

    Returns {graduated, block_reason, gates: {score, dsr, pbo}}.
    """
    # Load thresholds from scoring config or use defaults
    graduation_threshold = 0.5
    dsr_threshold = 1.96
    pbo_evict = 0.50
    min_experiments_for_dsr = 5

    # Try loading from scoring config
    for candidate in [
        _KATA_DIR.parent / "setup" / "scoring-config-defaults.json",
        _KATA_DIR / "setup" / "scoring-config-defaults.json",
        Path("/app/kata/scoring-config-defaults.json"),
    ]:
        try:
            cfg = json.loads(candidate.read_text(encoding="utf-8"))
            gates = cfg.get("OVERFITTING_GATES", {})
            dsr_threshold = float(gates.get("dsr_threshold", dsr_threshold))
            pbo_evict = float(gates.get("pbo_evict", pbo_evict))
            min_experiments_for_dsr = int(gates.get("min_kata_experiments_for_dsr_enforcement", min_experiments_for_dsr))
            break
        except (FileNotFoundError, json.JSONDecodeError):
            continue

    gates = {
        "score": {"value": round(score, 4), "threshold": graduation_threshold, "passed": score >= graduation_threshold},
        "dsr": {"value": round(dsr, 2), "threshold": dsr_threshold, "passed": dsr >= dsr_threshold, "enforced": experiments >= min_experiments_for_dsr},
        "pbo": {"value": round(pbo, 2), "threshold": pbo_evict, "passed": pbo <= pbo_evict},
    }

    block_reason = None
    if not gates["score"]["passed"]:
        block_reason = f"Score {score:.4f} < {graduation_threshold}"
    elif not gates["pbo"]["passed"]:
        block_reason = f"PBO {pbo:.2f} > {pbo_evict:.2f} — likely overfit"
    elif not gates["dsr"]["passed"] and gates["dsr"]["enforced"]:
        block_reason = f"DSR {dsr:.2f} < {dsr_threshold:.2f} (n_tried={experiments})"

    graduated = block_reason is None and gates["score"]["passed"]

    return json.dumps({
        "graduated": graduated,
        "block_reason": block_reason,
        "gates": gates,
    })


@mcp.tool(name="kata_validate_strategy")
async def kata_validate_strategy(code: str, ctx: Context) -> str:
    """AST-parse strategy code for syntax errors and FreqTrade IStrategy compliance.

    Args:
        code: The full Python source code of the strategy.

    Returns {valid: bool, errors: list[str]}.
    """
    errors = []

    # 1. Syntax check
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return json.dumps({"valid": False, "errors": [f"SyntaxError: {e}"]})

    # 2. IStrategy subclass check
    has_class = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                base_name = ""
                if isinstance(base, ast.Name):
                    base_name = base.id
                elif isinstance(base, ast.Attribute):
                    base_name = base.attr
                if base_name == "IStrategy":
                    has_class = True
    if not has_class:
        errors.append("No IStrategy subclass found")

    # 3. Required methods check
    required = {"populate_indicators", "populate_entry_trend", "populate_exit_trend"}
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in required:
            found.add(node.name)
    missing = required - found
    if missing:
        errors.append(f"Missing required methods: {sorted(missing)}")

    return json.dumps({"valid": len(errors) == 0, "errors": errors})
