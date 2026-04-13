# MACD Momentum System Architecture

Updated: 2026-04-13

This document replaces the older external architecture write-up as the current design reference for the system that is actually implemented today in this repository.

## Purpose

This system automates a MACD momentum trading workflow by combining:

- a TradingView Pine script that detects entries, scales, exits, and heartbeat state
- a Railway-hosted Node server that receives webhook events
- Schwab Trader API integration for execution
- local persistence, journaling, and safety monitors on the server side

## Source Of Truth

Current source files:

- Pine script: `tradingview/macd-momentum-alerts-v3.4.2_1.pine`
- Runtime entrypoint: `src/server.js`
- Webhook handling: `src/routes/webhook.js`
- Schwab integration: `src/services/schwab.js`
- Position and risk state: `src/services/positions.js`

## System Overview

```text
TradingView Pine Script
  -> JSON webhook alerts
  -> Railway Node server
  -> Schwab Trader API
  -> broker-side order placement

Server background jobs
  -> token refresh
  -> pending entry fill checks
  -> heartbeat expiry checks
  -> orphan position checks
  -> server-managed hard stop / scale / floor monitor
  -> logging and journaling
```

## What TradingView Does

The Pine script is not just a simple signal sender. It contains significant trading logic before any webhook is fired.

### Indicators And Core Context

The script calculates:

- MACD
- stochastic K
- EMA 9
- EMA 20
- session VWAP
- bar-to-bar MACD delta
- volume and confirmation score context

### Entry Paths

The script can open a trade through three paths:

1. `P1_CROSS`
   MACD crosses above signal after being below it for a minimum number of bars.
2. `P2_VWAP`
   Price breaks above session VWAP while MACD is already bullish and increasing.
3. `P3_SURGE`
   MACD is already above signal and accelerates sharply with stricter quality requirements.

### Confirmation Logic

The script supports a confirmation state machine before firing a `BUY`:

- waits a configurable number of bars after the initial raw trigger
- cancels confirmation if MACD loses strength or price falls below the trigger price
- scores the setup using histogram growth, stochastic direction, VWAP position, volume, MACD acceleration, and EMA alignment
- can require bar close before entry to reduce repaint behavior

This means many trades are filtered out in TradingView before the Railway server ever sees a `BUY`.

### Pine-Side Filters

The script blocks entries when configured filters fail:

- volume threshold
- regular-hours window
- dead-zone window
- cooldown after exits
- price below EMA 20
- StochK above overbought cap
- price too far above EMA 9
- price too far above current session VWAP

### Profit Management In Pine

The Pine script tracks in-position state and drives:

- 2 percent scale-out
- fast 4 percent scale-out
- 4 percent after 2 percent scale-out
- tiered exit logic
- profit-floor ratcheting
- heartbeat alerts while in a trade

### Exit Logic In Pine

Pine emits a `CLOSE` when one of these occurs:

- `MACD_BEAR`
- `FLOOR_BREACH`
- `STOCHK_TIER1_<level>`
- `STOCHK_TIER2_<level>`

Scale and exit alerts are designed to fire intrabar for faster reaction.

### Heartbeat Logic

While a position is active and no entry/scale/exit event is firing, Pine sends heartbeat alerts at bar close. Those carry:

- current profit percent
- current floor percent
- floor price
- max profit percent
- current tier

This gives the server a continuous view of whether the chart still believes the trade is valid.

## What The Railway Server Does

The Node server is an execution and state-management layer, not a strategy engine. It trusts TradingView to decide when to buy or close, then applies server-side risk handling and broker orchestration.

### Main Responsibilities

- receive and validate webhook requests
- reject invalid or duplicate signals
- place orders through Schwab
- track positions locally
- confirm pending limit entries against Schwab account positions before treating them as live
- persist state across restarts
- notify Discord
- reconcile server state against Schwab account state
- auto-close positions when heartbeat expires or floor rules are breached server-side

### Endpoints

- `POST /webhook`
- `GET /health`
- `GET /positions`
- `GET /summary`
- `GET /logs`
- `GET /auth/start`
- `GET /auth/callback`
- `GET /debug/schwab`

### BUY Handling

On `BUY`, the server:

- validates the token
- checks whether a position may be opened
- places a plain Schwab entry order
- opens a local position immediately for normal-session marketable entries
- stores a pending entry for extended-hours limit orders until Schwab shows a real fill
- stores the Pine snapshot for later analysis

### SCALE Handling

On `SCALE`, the server:

- confirms a tracked position exists
- calculates shares from `sell_pct`
- ignores duplicate milestone alerts if the server already executed that same scale
- sends a plain sell order for the requested shares
- updates local milestone and remaining position state only after the sell request succeeds

### CLOSE Handling

On `CLOSE`, the server:

- marks the position as closing
- cancels working orders for that ticker
- waits briefly for cancellation settlement
- sells remaining shares
- closes local state and journals P&L
- cancels pending entries cleanly if a close arrives before an extended-hours limit buy fills

### HEARTBEAT Handling

On `HEARTBEAT`, the server:

- refreshes the position's `lastSignalTime`
- returns current remaining quantity and stop data
- relies on background monitors to act if heartbeat disappears

## Server-Owned Protection

The current implementation intentionally moved active protection responsibility onto the server instead of relying on attached Schwab child stop orders.

- Hard stop is enforced by the server using quote polling, not a broker-attached stop.
- Profit floor and ratcheting are enforced by the same server monitor.
- Price-based scale milestones can also be executed by the server using configured thresholds.
- Pine still remains the source of truth for indicator-based invalidation exits such as `MACD_BEAR` and `STOCHK_*`.

This split keeps Pine as the chart and indicator source while letting the server own broker-safe execution logic across regular, pre-market, and post-market sessions.

## Webhook Contract

The Pine script currently sends four action types.

### BUY Payload

Fields observed in the current Pine file:

- `action`
- `path`
- `ticker`
- `price`
- `volume`
- `stochK`
- `stochKprev`
- `macd`
- `signal`
- `hist`
- `ema9`
- `ema20`
- `vwap`
- `score`
- `confirmBars`
- `crossPrice`
- `token`

### SCALE Payload

Fields observed:

- `action`
- `level`
- `sell_pct`
- `ticker`
- `price`
- `stochK`
- `macd`
- `hist`
- `profitPct`
- `token`

### CLOSE Payload

Fields observed across reasons:

- `action`
- `reason`
- `ticker`
- `price`
- `stochK`
- `macd`
- `hist`
- `profitPct`
- `tier`
- `token`

Sometimes also:

- `floorPct`
- `maxProfitPct`

### HEARTBEAT Payload

Fields observed:

- `action`
- `ticker`
- `price`
- `profitPct`
- `floorPct`
- `floorPrice`
- `maxProfitPct`
- `tier`
- `token`

## Persistence And Observability

The server persists runtime information to disk:

- positions: `data/positions.json`
- daily state: `data/state.json`
- structured logs: `logs/YYYY-MM-DD.jsonl`
- trade journal: `logs/journal/trades-YYYY-MM-DD.jsonl`

Available observability:

- health endpoint
- recent logs endpoint
- daily summary endpoint
- Discord notifications
- Schwab debug endpoint

## Important Alignment Notes

This is the most important section for future maintenance.

### 1. Pine And Server Both Manage Different Parts Of Risk

Risk is split across both layers:

- Pine handles entry gating, cooldown, path selection, and strategic exit decisions.
- Server handles execution, persistence, broker order state, and safety automation.

This split is intentional. The goal is not to make the server duplicate every Pine rule. Pine is the chart-facing signal engine and visual decision layer, while the server is the broker-facing execution and fail-safe layer.

### 2. Cooldown Exists In Pine, Not In Server By Design

The Pine script implements cooldown bars after exits.

The server does not currently enforce a matching cooldown by itself, and that is acceptable for this architecture. Cooldown is part of the TradingView strategy behavior, not a required server-side duplication target.

### 3. Floor Logic Exists In Both Pine And Server

Pine computes a profit-floor system for trading logic and heartbeat payloads.

The server separately runs a floor monitor using environment variables:

- `FLOOR_AT_1PCT`
- `FLOOR_AT_2PCT`
- `FLOOR_AT_3PCT`
- `FLOOR_AT_4PCT`
- `FLOOR_TRAIL_GAP`

These should stay numerically aligned with the Pine inputs:

- `floor1pct`
- `floor2pct`
- `floor3pct`
- `floor4pct`
- `floorTrailGap`

### 4. Time Filters Are Not Fully Symmetric On Purpose

Pine has:

- regular-hours filtering
- dead-zone filtering
- cooldown gating

The server has:

- trading-hours gating
- no dead-zone logic
- no cooldown logic

This asymmetry is acceptable because the server's job is not to reproduce Pine's entire chart-level decision process. Server rules should stay focused on execution safety, broker interaction, and fail-safe behavior.

### 5. Path Names Are Informational

Pine sends path names such as:

- `P1_CROSS`
- `P2_VWAP`
- `P3_SURGE`

The server logs and stores them, but does not currently branch execution logic based on path type.

### 6. TradingView Site Updates Are Manual

This repository can store and maintain the Pine source, but it cannot directly edit the TradingView website from this environment.

Recommended workflow:

1. Update the Pine file in GitHub.
2. Review and commit changes.
3. Paste the current Pine source into TradingView manually.

## Current Recommended Maintenance Workflow

1. Treat the Pine file and `src/` server as one versioned system.
2. When Pine payload fields change, update `src/routes/webhook.js` only if parsing expectations need to change.
3. When floor or session rules change in Pine, check the matching server environment settings.
4. Record meaningful changes in `docs/SESSION_LOG.md`.
5. Keep this document updated instead of relying on the old external `.docx` file.

## Suggested Future Cleanup

- consider persisting Schwab tokens if Railway restarts are common
- decide whether Pine parameter defaults should be documented in a dedicated operations guide
- add more route-level and broker-integration test coverage before behavior-changing refactors
