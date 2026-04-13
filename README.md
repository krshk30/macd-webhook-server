# MACD Momentum Webhook Server

TradingView alerts -> Railway-hosted Node server -> Schwab Trader API -> order execution.

This repository is the execution backend for a MACD momentum workflow. TradingView sends JSON alerts to the server, the server validates and deduplicates them, and Schwab orders are placed with position tracking, stop management, persistence, and trade journaling.

## Current Status

- Active runtime: `src/server.js`
- Current version in code: `v1.3.0`
- Hosting target: Railway
- Broker integration: Schwab Trader API
- TradingView Pine script: `tradingview/macd-momentum-alerts-v3.4.2_1.pine`

## What The Server Does

The server accepts webhook payloads from TradingView and processes four signal types:

- `BUY`: open a new position if risk guards allow it
- `SCALE`: sell part of an existing position and re-protect the remainder
- `CLOSE`: exit the remaining position and finalize trade accounting
- `HEARTBEAT`: confirm that TradingView is still actively tracking the open trade

The current implementation is more advanced than the original architecture document in a few areas:

- Positions and daily state are persisted to disk under `data/`
- Structured logs and trade journals are written under `logs/`
- Server-side heartbeat expiry, orphan detection, and floor monitoring are active
- The repository has been cleaned so the modular `src/` tree is the active runtime source of truth

## Signal Flow

```text
TradingView alert
  -> POST /webhook
  -> token validation
  -> duplicate filter
  -> action handler
  -> Schwab API order placement
  -> position state update
  -> journal/log/notification
```

Background monitors run after startup:

- Heartbeat checker: every 30 seconds
- Orphan position checker: every 60 seconds
- Floor monitor: every 5 seconds by default
- Token refresh: every 25 minutes

## Execution Model

### BUY

- Validates token and required fields
- Rejects the signal if:
  - the ticker is already open
  - max positions is reached
  - daily loss limit has been exceeded
  - current time is outside configured trading hours
- Places a Schwab `TRIGGER` order:
  - parent: `BUY`
  - child: protective `STOP` or `STOP_LIMIT`
- Opens the position in local state
- Stores signal metadata for post-trade analysis

### SCALE

- Requires an existing position
- Cancels the tracked stop and any working orders for that ticker
- Calculates shares to sell from `sell_pct`
- Marks the milestone in local state
- Places either:
  - `SELL + child STOP` trigger order if shares remain
  - plain `SELL` if the scale fully exits the trade

### CLOSE

- Requires an existing position
- Cancels tracked stop and any working orders
- Waits briefly for cancellations to settle
- Places a market or session-safe limit sell through Schwab
- Finalizes P&L and trade journal entries

### HEARTBEAT

- Refreshes `lastSignalTime` for the open position
- Does not place orders directly
- Works together with the heartbeat expiry monitor to detect repaints or broken alert flow

## Safety And Risk Controls

Implemented in `src/services/positions.js` and `src/services/schwab.js`:

- Shared secret webhook token validation
- Duplicate alert filter
- Max concurrent positions
- Daily loss cutoff
- Trading-hours gate
- Disk-backed position persistence across restarts
- Orphan position detection against Schwab account state
- Heartbeat timeout auto-close logic
- Server-side floor monitoring and stop ratcheting
- Discord notifications for key events

## API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | Basic service info |
| `/health` | `GET` | Health, auth status, trading state |
| `/positions` | `GET` | Open positions and daily state |
| `/summary` | `GET` | Daily trade summary |
| `/logs?n=50` | `GET` | Recent structured logs |
| `/webhook` | `POST` | TradingView webhook receiver |
| `/auth/start` | `GET` | Starts Schwab OAuth flow |
| `/auth/callback` | `GET` | Schwab OAuth callback |
| `/debug/schwab` | `GET` | Schwab endpoint diagnostics |

## Webhook Payloads

### BUY

```json
{
  "action": "BUY",
  "ticker": "AAPL",
  "price": 191.23,
  "path": "P1_MACD",
  "score": 7,
  "stochK": 41.2,
  "macd": 0.14,
  "hist": 0.03,
  "vwap": 191.04,
  "ema9": 190.98,
  "ema20": 190.71,
  "volume": 182930,
  "token": "your-secret-token"
}
```

### SCALE

```json
{
  "action": "SCALE",
  "ticker": "AAPL",
  "price": 194.10,
  "level": "PCT2",
  "sell_pct": 50,
  "token": "your-secret-token"
}
```

### CLOSE

```json
{
  "action": "CLOSE",
  "ticker": "AAPL",
  "price": 193.55,
  "reason": "MACD_BEAR",
  "token": "your-secret-token"
}
```

### HEARTBEAT

```json
{
  "action": "HEARTBEAT",
  "ticker": "AAPL",
  "tier": "FLOOR_2",
  "profitPct": 2.35,
  "token": "your-secret-token"
}
```

## Environment Variables

Use `env.example` as the starting point.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Server port. Defaults to `3000` |
| `SCHWAB_CLIENT_ID` | Yes | Schwab app key |
| `SCHWAB_CLIENT_SECRET` | Yes | Schwab app secret |
| `SCHWAB_ACCOUNT_ID` | Yes | Schwab account number fallback |
| `SCHWAB_ACCOUNT_HASH` | No | Optional cached account hash override |
| `SCHWAB_CALLBACK_URL` | Yes | OAuth callback URL |
| `WEBHOOK_TOKEN` | Yes | Shared secret used by TradingView |
| `DEFAULT_QUANTITY` | No | Default shares per entry |
| `MAX_POSITIONS` | No | Max concurrent open positions |
| `MAX_DAILY_LOSS` | No | Buy-side lockout threshold |
| `TRADING_START_HOUR` | No | Start hour in Eastern Time |
| `TRADING_END_HOUR` | No | End hour in Eastern Time |
| `ORPHAN_TIMEOUT_MINS` | No | Minutes before orphan auto-close |
| `HEARTBEAT_TIMEOUT_SECS` | No | Seconds before heartbeat expiry |
| `LIMIT_BUFFER_CENTS` | No | Buffer used for extended-hours limit conversion |
| `STOP_LOSS_CENTS` | No | Initial stop distance from entry |
| `FLOOR_CHECK_INTERVAL_SECS` | No | Polling interval for floor monitor |
| `FLOOR_AT_1PCT` | No | Profit floor applied at 1 percent profit |
| `FLOOR_AT_2PCT` | No | Profit floor applied at 2 percent profit |
| `FLOOR_AT_3PCT` | No | Profit floor applied at 3 percent profit |
| `FLOOR_AT_4PCT` | No | Profit floor applied at 4 percent profit |
| `FLOOR_TRAIL_GAP` | No | Gap for trailing floor above 4 percent |
| `DEDUP_WINDOW_MS` | No | Duplicate alert window |
| `ENABLE_FILE_LOG` | No | Enables disk logging when not set to `false` |
| `DISCORD_WEBHOOK_URL` | No | Discord notifications |
| `DATA_DIR` | No | Override data persistence directory |
| `LOG_DIR` | No | Override log directory |

## Repository Layout

```text
src/
  server.js
  routes/
  services/
docs/
  PROJECT_STATE.md
  SESSION_LOG.md
tradingview/
  README.md
env.example
```

Notes:

- The `src/` tree is the active application.
- Legacy root-level runtime files and the old patch artifact have been removed as part of cleanup.

## TradingView Script Status

The TradingView Pine script is now stored in this repository at `tradingview/macd-momentum-alerts-v3.4.2_1.pine`.

Codex can maintain that file here, but cannot directly edit the TradingView website itself from this environment. The intended workflow is:

1. Update the Pine file in this repo.
2. Review and commit the changes in GitHub.
3. Paste the latest script into TradingView manually.

## Recommended Next Steps

1. Keep the `src/` implementation as the source of truth.
2. Keep webhook payload fields synchronized between the Pine script and `src/routes/webhook.js`.
3. Use `docs/MACD_Momentum_System_Architecture_2026-04-13.md` as the current system design reference.
4. Keep expanding automated coverage around webhook and Schwab-facing behavior before deeper refactors.
