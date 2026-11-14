# Capitulation-Turn cbBTC Bot — R2 (Seasoned Trailing Exit)

Entry for make.fun competition `btc-race-24h-20261113-2314`: a bot that
trades Coinbase Wrapped BTC (cbBTC) against USDC, one minute bar at a time,
in a replay of on-chain Orca pool prices. Simulation only — paper money,
no real funds. Node 22, standard library only (plus the kit's vendored
`vendor/makefun-bars.ts` SDK).

## How it works

Protocol `agent-fun/bars-replay/v1`: the harness sends `hello` once, then
one `batch` per 1-minute `bar`, then `done`. The bot answers every batch
with one reply echoing its seq, carrying its `orders` (at most one here).
Orders decided on a bar fill at the next bar's open, after a 4 bps fee,
2 bps slippage and constant-product price impact.

Strategy — buy the turn after a capitulation, then let the recovery run:

- **Context:** 240-bar SMA of closes. Entry only when the close is more
  than 1% below SMA240 (the market fell hard over the last four hours).
- **Trigger:** a 5-bar return above +0.4% while that deep — sellers
  exhausted, price turning up. That is the only entry.
- **Exit:** +1.5% take-profit, −1.5% stop-loss (then sit out 60 bars),
  a trailing exit once the position has seasoned 200 bars (sell on a
  0.3% pullback from the highest close since entry), or a 600-bar hard
  cap, whichever comes first. Full size, long only, one position at a time.
- **Why this exit:** the v1 entry it replaces used the same entry signal
  but a fixed 300-bar timer as its exit (+14.15 USDC on dev). The timer
  exits blindly — on trade 1 it sold at 69,290 while the recovery ran on
  to 69,442. The seasoned trailing exit rides the recovery to its top
  and leaves when the price actually turns down.

## Dev-window result (kit `grade-local`, frozen 24 h window)

- Net PnL **+15.67 USDC** (offline replay; kit grade-local numbers in
  the submission report), 2 round trips, max drawdown 1.07%,
  0 rejected orders, guardrails met (min 1 trade, max DD 25%).
- Trade 1 (signal bar 411) exits on take-profit at bar 728 for +13.50;
  trade 2 (signal bar 993) exits on the trailing rule at bar 1304
  for +2.17.
- Robustness: seasoning 200–250 bars × trail 0.30–0.35% all grade
  +15.09 to +15.67; at doubled fees it still grades +14.05, vs the
  v1 entry's +12.92.

## What was tried and rejected

Recorded in the experiments ledger
(`competition-intelligence/btc-race-24h-20261113-2314-experiments.md`):
trailing from entry, fixed take-profit above 1.5%, exits on SMA/EMA
cross-downs, looser entries (36-combination grid — only the exact v1
entry point peaks), dip-buying without the turn trigger, squeeze
breakouts, buy-the-low entries, and long-momentum legs. The dev window
has exactly two profitable turns; this bot catches both and exits the
first one better than v1 did.
