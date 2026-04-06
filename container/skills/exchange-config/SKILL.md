---
name: exchange-config
description: >
  Configure exchange, trading mode, and additional trading pairs for this agent instance.
  Writes instance-config.json which scout, market-timing, monitor, and other skills read
  for pair lists and exchange settings. Trigger on: "exchange config", "configure exchange",
  "set exchange", "add pairs", "add trading pairs", "change exchange", "switch to kraken",
  "switch to coinbase", "switch to binance", "show exchange config", "which exchange",
  "what pairs", "remove pairs", "reset exchange".
---

# Exchange Config — Instance Configuration Manager

Configure which exchange this instance trades on and manage the active pair list.
Writes `instance-config.json` which scout, market-timing, monitor, and other skills
read at runtime.

## Data Sources

| File | Purpose | Required |
|------|---------|----------|
| `instance-config.json` | Current instance configuration | No (created by this skill) |
| `skills/archetype-taxonomy/archetypes.yaml` | Default 20 pairs + tier definitions | Yes |

```bash
cat {WORKSPACE}/instance-config.json 2>/dev/null || echo "{}"
cat {WORKSPACE}/skills/archetype-taxonomy/archetypes.yaml
```

## Supported Exchanges

| Exchange | Name (ccxt) | Trading Mode | Pair Suffix | Stake | Notes |
|----------|-------------|-------------|-------------|-------|-------|
| Binance | `binance` | futures | `/USDT:USDT` | USDT | **Default.** Best liquidity for all 20 pairs. |
| Binance | `binance` | spot | `/USDT` | USDT | No leverage. Simpler pair format. |
| Kraken | `kraken` | futures | `/USD:USD` | USD | May not list all 20 default pairs. Check availability. |
| Kraken | `kraken` | spot | `/USD` | USD | USD-denominated. |
| Coinbase | `coinbase` | spot | `/USD` | USD | Spot only. Limited futures support. |
| Bybit | `bybit` | futures | `/USDT:USDT` | USDT | Similar format to Binance. |
| OKX | `okx` | futures | `/USDT:USDT` | USDT | Similar format to Binance. |

## Commands

### Show Current Config

When user asks "show exchange config", "which exchange", or "what pairs":

1. Read `instance-config.json` (or report defaults if missing)
2. Read `archetypes.yaml` for default pair list
3. Compute effective pair list: `default_pairs + additional_pairs - remove_pairs`
4. Compute cell count: `7 archetypes x effective_pair_count x 4 timeframes`
5. Display config summary using the format below

### Set Exchange

When user asks "set exchange to kraken", "switch to coinbase", etc.:

1. Read current `instance-config.json` (or start from defaults)
2. Look up exchange name, trading_mode, stake_currency, pair_suffix from the table above
3. **Validate pair availability**: call `freqtrade_list_pairs(exchange=<name>)` to check which of the effective pairs are available on the target exchange
4. If some default pairs are unavailable, add them to `remove_pairs` and warn the user
5. Write updated `instance-config.json`
6. Display summary showing exchange change and any pair removals
7. Warn about downstream impact (see Impact Warning below)

### Add Pairs

When user asks "add PEPE and WIF" or "add more pairs":

1. Read current config
2. For each requested pair:
   a. Validate the pair exists on the configured exchange: `freqtrade_list_pairs(exchange=<name>, quote=<stake_currency>)`
   b. Check it is not already in the default 20 or additional_pairs
   c. Assign tier T5 unless user specifies otherwise
3. Append to `additional_pairs`
4. Write updated `instance-config.json`
5. Display new cell count and pair list

### Remove Pairs

When user asks "remove SHIB" or "drop TON":

1. If the pair is in the default 20, add to `remove_pairs`
2. If the pair is in `additional_pairs`, remove from that array
3. Write updated `instance-config.json`
4. Display new cell count

### Reset to Defaults

When user asks "reset exchange config" or "use defaults":

1. Delete `instance-config.json` (or write `{}`)
2. Confirm: "Reset to defaults: binance futures, 20 pairs, 560 cells"

## Effective Pair List Computation

All skills that need the pair list use this algorithm:

```
1. Read archetypes.yaml -> default_pairs (20 symbols)
2. Read instance-config.json -> additional_pairs, remove_pairs
   (if file missing or empty, additional_pairs = [], remove_pairs = [])
3. effective_pairs = [p for p in default_pairs if p not in remove_pairs]
                     + [p.symbol for p in additional_pairs]
4. effective_pair_count = len(effective_pairs)
5. total_cells = 7 x effective_pair_count x 4
```

When `instance-config.json` does not exist, effective_pairs = default 20, total_cells = 560.

## Pair Format Resolution

Skills work with **base symbols internally** (e.g., "BTC", "ETH"). The full FreqTrade
pair notation is constructed only at MCP tool boundaries (backtests, bot starts, data downloads):

```
pair_suffix = instance-config.json -> exchange.pair_suffix (default: "/USDT:USDT")
full_pair = symbol + pair_suffix

Examples:
  "BTC" + "/USDT:USDT" = "BTC/USDT:USDT"  (binance futures)
  "BTC" + "/USD"        = "BTC/USD"          (coinbase spot)
  "BTC" + "/USD:USD"    = "BTC/USD:USD"      (kraken futures)
```

## Pair Tiers

| Tier | Description | Default Pairs |
|------|-------------|---------------|
| T1 | Highest liquidity | BTC, ETH, SOL, XRP, BNB |
| T2 | Good liquidity | DOGE, ADA, AVAX, LINK, TON |
| T3 | Moderate liquidity | SUI, DOT, SHIB, NEAR, UNI |
| T4 | Adequate liquidity | LTC, BCH, APT, ARB, OP |
| T5 | User-added | Lowest default liquidity assumption |

T5 pairs are NOT added to any archetype's `preferred_pairs`. They participate in the full
cell grid but archetypes will not prioritize them for research. Execution_fit scoring
naturally handles liquidity differences — low-volume T5 pairs score lower on execution_fit.

## Output Schema

Write to: `{WORKSPACE}/instance-config.json`

```json
{
  "exchange": {
    "name": "binance",
    "trading_mode": "futures",
    "margin_mode": "isolated",
    "stake_currency": "USDT",
    "pair_suffix": "/USDT:USDT"
  },
  "additional_pairs": [
    {"symbol": "PEPE", "tier": "T5"},
    {"symbol": "WIF", "tier": "T5"}
  ],
  "remove_pairs": [],
  "updated_at": "2026-04-04T14:00:00Z",
  "updated_by": "user"
}
```

## Display Format

```
Exchange Config
Exchange: binance (futures, isolated)
Stake: USDT | Pair suffix: /USDT:USDT

Pair List (22 active)
Default (20): BTC, ETH, SOL, XRP, BNB, DOGE, ADA, AVAX, LINK, TON, SUI, DOT, SHIB, NEAR, UNI, LTC, BCH, APT, ARB, OP
Added (2): PEPE [T5], WIF [T5]
Removed (0): none

Cell Grid
7 archetypes x 22 pairs x 4 timeframes = 616 cells
(default: 560 with 20 pairs)
```

## Impact Warning

After any config change, display:

```
Config changed. Downstream impact:
- Scout: will scan {total_cells} cells instead of 560 on next run
- Market-timing: will score {total_cells} cells, fetch regime data for {pair_count} pairs
- Monitor: will read updated pair list for deployments
- Kata: config.json exchange field still uses binance — may need manual update for other exchanges
```

## Known Gaps

- **Kata**: `kata/tasks/wf-4window/environment/files/config.json` hardcodes binance.
  For non-binance exchanges, the kata config needs manual adjustment until kata is made
  exchange-aware.
- **Data downloads**: Switching exchanges may require re-downloading historical data
  for the new exchange via `freqtrade_download_data`.
