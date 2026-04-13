# Project State

## Current Understanding

This repository is a production-oriented webhook execution server for a MACD momentum trading workflow:

- TradingView produces alert events
- Railway hosts the webhook server
- The Node server translates alerts into Schwab Trader API orders
- Position state and trade history are tracked locally

The current live implementation is the modular `src/` application, not the older files at the repository root.

## What Matches The Original Architecture

- TradingView webhook ingestion
- Schwab OAuth and order placement
- Shared-secret auth token
- Duplicate filtering
- Position tracking
- Scale exits
- Final close handling
- Health and debugging endpoints
- Discord notifications

## What Has Evolved Beyond The Original Architecture

- Disk-backed persistence in `data/positions.json` and `data/state.json`
- Structured JSON logs plus daily trade journals in `logs/`
- Heartbeat-based trade validity checks
- Orphan detection against broker account state
- Server-side floor monitor that ratchets stops and exits on breaches
- Modular route and service layout under `src/`

## Gaps Or Drift To Be Aware Of

- The architecture document talks about bracket-style TP, SL, and trailing-stop behavior; the current implementation is centered on protective stop logic plus server-driven floor management.
- The architecture document mentions cooldown tracking, but there is no current cooldown implementation in the code.
- The TradingView Pine script is now stored in this repository, which means webhook payload design is finally version-controlled alongside the backend.
- The repo has been cleaned so the active implementation now lives clearly under `src/` plus `tradingview/`.

## Canonical Runtime Files

- `src/server.js`
- `src/routes/webhook.js`
- `src/routes/auth.js`
- `src/routes/health.js`
- `src/routes/debug.js`
- `src/services/schwab.js`
- `src/services/positions.js`
- `src/services/logger.js`
- `src/services/notifications.js`

## Practical Maintenance Advice

- Treat `src/` as the source of truth.
- Keep the Pine script in this repo and treat it as the source of truth for TradingView alert behavior.
- Update backend docs whenever webhook payload fields change.
- Revisit token persistence if Railway restarts become operationally important.
- Continue growing tests around webhook and broker-facing logic before larger refactors.
