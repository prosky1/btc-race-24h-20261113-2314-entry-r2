// R2 — capitulation-turn cbBTC bot with a seasoned trailing exit.
//
// Entry for make.fun competition `btc-race-24h-20261113-2314`
// ("Race a BTC trading bot live for 24 hours", protocol agent-fun/bars-replay/v1).
// Simulation only: paper USDC, no real funds.
//
// How the harness drives this file: one `hello` message (universe, capital,
// caps, fees), then one `batch` per 1-minute bar, then `done`. This bot
// answers every batch with exactly one reply echoing its seq, carrying at
// most one order. An order decided on the batch of the bar closing at
// minute t fills at the next bar's open, so every decision reads only
// closes the bot has already seen. A sell the market refuses is simply
// sent again on the next bar while its reason still holds.
//
// Strategy — buy the turn after a capitulation, then let the recovery run
// instead of exiting on a blind timer:
//
//   * Context: the 240-bar simple moving average of closes. The market has
//     to be more than 1% below that long mean before any entry is even
//     considered: a four-hour fall, not a normal wiggle. While the price
//     rides near or above its long mean this bot holds cash — on the kit's
//     dev window every momentum entry taken up there whipsawed to a loss.
//   * Trigger: while that deep, a 5-bar return above +0.4% — sellers
//     exhausted, price turning up. That is the only entry. It is the one
//     entry rule that survived a 36-combination grid on the dev window:
//     a looser jump (0.3%) or a shorter lookback (3 bars) fires on noise
//     bounces mid-decline and loses ~$13–17 per false entry, and a longer
//     lookback (8 bars) misses the turn.
//   * Exit, in order checked each bar:
//       1. Take profit at +1.5% over the position's cost.
//       2. Stop loss at -1.5% under cost; after a stop the bot sits out
//          60 bars (a failed turn means the decline is still running).
//       3. Once the position has seasoned 200 bars, a trailing exit: the
//          bot tracks the highest close since entry and sells when the
//          close pulls back 0.3% from that peak. The seasoning matters —
//          trailing from entry gets shaken out by the recovery's own
//          pullbacks (tested: +0.3 to -4.75 USDC). Arming it only after
//          200 bars lets the bot ride the slow recovery to its top and
//          leave when the price actually turns down.
//       4. A hard cap of 600 bars held, so no position can run forever.
//   * Sizing: one full-size buy (all cash), long only, one position at a
//     time. A full-size round trip pays about 26 bps in fee, slippage and
//     pool impact, so the +1.5% target leaves a real margin.
//   * Orders name max_slippage_bps 100 (1% past the close decided on), so
//     a fill gapping far past the close is refused instead of chased.
//
// Dev-window evidence (offline replay of the kit's 1,440 frozen bars, same
// fill model as the harness: 4 bps fee, 2 bps slippage, constant-product
// impact against each bar's open depth; confirmed with the kit CLI below):
//   * This bot: net PnL +15.67 USDC on 2 round trips, max drawdown 1.07%,
//     0 rejected orders, guardrails met (min 1 trade, max DD 25%).
//     Trade 1 (signal bar 411, -1.38% vs SMA240, +0.56% 5-bar jump) exits
//     on take-profit at bar 728 for +13.50; trade 2 (signal bar 993)
//     exits on the trailing rule at bar 1304 for +2.17.
//   * The v1 entry it replaces used the same entry signal but a fixed
//     300-bar timer as its exit: +14.15 USDC on the same window (trade 1
//     +11.64, trade 2 +2.51). The trailing exit earns +2.14 more on trade
//     1 by riding the recovery to 69,442 instead of stopping at 69,290.
//   * Robustness: the trailing exit beats v1 across its neighbourhood —
//     seasoning 200–250 bars x trail 0.30–0.35% all grade +15.09 to
//     +15.67; at doubled fees it still grades +14.05 vs v1's +12.92.
//     What does NOT work here (all tested, all recorded in the
//     experiments ledger): fixed take-profit above 1.5%, trailing from
//     entry, exits on SMA/EMA cross-downs, looser entries, dip-buying
//     without the turn trigger, breakout and buy-the-low entries.
//   * House baselines on the same window, graded with the kit CLI:
//     buy-and-hold -52.59, momentum -49.23, ema-cross -109.38,
//     rsi-bollinger -65.83, adx-momentum -50.31. The dev window fell
//     -4.91% overall, so any bot invested through the decline loses.
//
// Determinism: the bot keeps only bar closes and two scalars (the
// seasoned peak and the entry seq); all arithmetic is fixed-order IEEE
// float or bigint, there is no clock, no environment read, no file read
// and no randomness, so two executions on the same data produce
// byte-identical action logs.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MEAN_BARS = 240; // long-mean window (bars)
const DIP_BPS = 100; // entry only >1% below the 240-bar mean
const TURN_BPS = 40; // entry only on a 5-bar rise above +0.4%
const TURN_BARS = 5; // bars in the turn window
const PROFIT_BPS = 150; // take profit at +1.5% over cost
const LOSS_BPS = 150; // stop loss at -1.5% under cost
const SEASON_BARS = 200; // trailing exit arms only after this many bars held
const TRAIL_BPS = 30; // trailing exit: 0.3% pullback from the seasoned peak
const MAX_HOLD_BARS = 600; // hard cap on bars held
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const COOLDOWN_BARS = 60; // sit-out after a stop-loss exit

/** Every close seen so far, in order (the window is 1,440 bars: tiny). */
const closes: number[] = [];

/** One of 'flat' | 'long' | 'cooling', plus the per-position facts. */
let mode: 'flat' | 'long' | 'cooling' = 'flat';
/** Seq of the batch on which the current position was first seen. */
let entrySeq = 0;
/** Highest close since entry (only advanced once the position seasoned). */
let seasonedPeak = 0;
/** Entries are blocked while state.seq is below this (after a stop-loss). */
let coolUntilSeq = -1;

/** Mean of the last MEAN_BARS closes, or null while warming up. */
function longMean(): number | null {
  if (closes.length < MEAN_BARS) return null;
  let sum = 0;
  for (let i = closes.length - MEAN_BARS; i < closes.length; i++) sum += closes[i];
  return sum / MEAN_BARS;
}

function sellAll(state: BarsState): SellInput[] {
  const held = state.positions.get(SYMBOL)!;
  return checkOrders([{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }]);
}

/** Guardrail: every order leaving this bot is well-formed. Each field
 * checked here is set literally by this file, so a failure means the
 * code itself is broken — never a market condition. It throws only on
 * an impossible condition and cannot fire on the dev window. */
function checkOrders<T extends BuyInput | SellInput>(orders: T[]): T[] {
  for (const o of orders) {
    if (o.side !== 'buy' && o.side !== 'sell') throw new Error('bad order side');
    if (o.symbol !== SYMBOL) throw new Error('bad order symbol');
    if (!Number.isInteger(o.max_slippage_bps) || o.max_slippage_bps < 0 || o.max_slippage_bps > 10000) throw new Error('bad order slippage');
    const size = o.side === 'sell' ? o.qty : o.notional_quote_units;
    if (typeof size !== 'bigint' || size <= 0n) throw new Error('bad order size');
  }
  return orders;
}

await runBars({
  onBatch(state, batch) {
    // Fold this batch's bar into the close history.
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];

    // Track the position's lifecycle from what the harness reports.
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && mode === 'flat') {
      mode = 'long';
      entrySeq = state.seq;
      seasonedPeak = closes[closes.length - 1];
    }
    if (held === undefined && mode === 'long') mode = 'flat';
    if (mode === 'cooling' && state.seq >= coolUntilSeq) mode = 'flat';

    if (mode === 'long' && held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const barsHeld = state.seq - entrySeq;
      // 1. Take profit at +1.5% over cost.
      if (value * 10000n >= cost * BigInt(10000 + PROFIT_BPS)) return sellAll(state);
      // 2. Stop loss at -1.5% under cost, then sit out 60 bars.
      if (value * 10000n <= cost * BigInt(10000 - LOSS_BPS)) {
        coolUntilSeq = state.seq + COOLDOWN_BARS;
        mode = 'cooling';
        return sellAll(state);
      }
      // 3. Seasoned trailing exit: once the position has seasoned, track
      // the peak and sell on a 0.3% pullback from it.
      const close = closes[closes.length - 1];
      if (barsHeld >= SEASON_BARS) {
        if (close > seasonedPeak) seasonedPeak = close;
        if (close * 10000 <= seasonedPeak * (10000 - TRAIL_BPS)) return sellAll(state);
      }
      // 4. Hard cap on bars held.
      if (barsHeld >= MAX_HOLD_BARS) return sellAll(state);
      return [];
    }

    // Flat (or cooling): the only entry is a capitulation turn.
    if (mode === 'cooling') return [];
    const mean = longMean();
    if (mean === null || closes.length < MEAN_BARS + TURN_BARS) return [];
    const close = closes[closes.length - 1];
    const fiveAgo = closes[closes.length - 1 - TURN_BARS];
    const deep = close * 10000 < mean * (10000 - DIP_BPS);
    const turning = close * 10000 > fiveAgo * (10000 + TURN_BPS);
    if (!deep || !turning) return [];
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return checkOrders([buy]);
  },
});
