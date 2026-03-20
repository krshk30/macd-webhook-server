# MACD Momentum Webhook Server v1.3.0

TradingView alerts → Schwab Trader API → TOS execution.

## v1.3.0: Logging Overhaul + Position Persistence

### Logging Overhaul
- **Structured JSON logs**: Every log line written as JSON to daily `.jsonl` files
- **Trade IDs**: Every position gets a unique ID (e.g. `T-20260320-CURV-001`) for tracing its entire lifecycle from BUY → SCALE → CLOSE
- **Trade Journal**: Separate daily journal file with only trade events (BUY/SCALE/CLOSE/HEARTBEAT_EXPIRED) — no noise
- **Daily Summary endpoint**: `GET /summary` returns win rate, P&L, trade count for the day
- **Recent logs endpoint**: `GET /logs?n=50` returns last N structured log entries
- **Entry data stored**: Every position stores the full indicator snapshot (MACD, StochK, VWAP, EMA, score) from the BUY webhook for post-trade analysis

### Position Persistence
- **Survives restarts**: Positions saved to `data/positions.json` on every change
- **Auto-restore**: On startup, loads positions from disk — no more orphan chaos on Railway deploys
- **Daily state**: P&L and trade count persisted and auto-reset on new trading day
- **Trade history**: Full journal in `logs/journal/trades-YYYY-MM-DD.jsonl`

## Flow
```
TV Alert → POST /webhook → authenticate → deduplicate
  → BUY:   canOpen? → Schwab order → track position → journal → persist
  → SCALE: has position? → calc shares → Schwab order → journal → persist  
  → CLOSE: cancel pending → Schwab order → journal → Discord → persist
  → HEARTBEAT: touch position timer

Background:
  Every 30s: check heartbeat timeouts → fetch live price → sell → journal
  Every 60s: check Schwab for orphan positions → auto-close after timeout
```

## Changelog
- v1.3.0: Structured logging, trade IDs, trade journal, position persistence, daily summary
- v1.2.9: getCurrentPrice for heartbeat expired
- v1.2.8: Heartbeat pattern
- v1.2.7: LIMIT buffer, no brackets
- v1.2.5: Fixed cancelOrdersForTicker
- v1.2.4: Zero-qty guard

## Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| / | GET | Service info |
| /health | GET | Health check, token status, positions |
| /positions | GET | Current open positions with trade IDs |
| /summary | GET | Daily trade summary (win rate, P&L) |
| /summary?date=2026-03-20 | GET | Summary for specific date |
| /logs?n=50 | GET | Recent structured log entries |
| /webhook | POST | Receive TV alerts (requires token) |
| /auth/start | GET | Start Schwab OAuth2 flow |
| /auth/callback | GET | OAuth2 callback (automatic) |
| /debug/schwab | GET | Test all Schwab API endpoints |

## Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| SCHWAB_CLIENT_ID | Yes | | App Key from developer.schwab.com |
| SCHWAB_CLIENT_SECRET | Yes | | Secret from developer.schwab.com |
| SCHWAB_ACCOUNT_ID | Yes | | Schwab brokerage account number |
| SCHWAB_CALLBACK_URL | Yes | | https://your-app.up.railway.app/auth/callback |
| WEBHOOK_TOKEN | Yes | | Must match TradingView alert payloads |
| DEFAULT_QUANTITY | No | 10 | Shares per trade |
| MAX_POSITIONS | No | 3 | Max concurrent positions |
| MAX_DAILY_LOSS | No | -500 | Stop trading after this loss |
| TRADING_START_HOUR | No | 7 | Start hour ET |
| TRADING_END_HOUR | No | 18 | End hour ET |
| ORPHAN_TIMEOUT_MINS | No | 5 | Auto-close orphan after N mins |
| HEARTBEAT_TIMEOUT_SECS | No | 60 | Heartbeat expiry threshold |
| LIMIT_BUFFER_CENTS | No | 0.01 | Buffer for LIMIT orders |
| DEDUP_WINDOW_MS | No | 5000 | Duplicate filter window |
| ENABLE_FILE_LOG | No | true | Write logs to disk |
| DISCORD_WEBHOOK_URL | No | | Discord notifications |

## Deploy to Railway
1. Push to GitHub (private repo)
2. Railway → New Project → Deploy from GitHub
3. Set environment variables (see .env.example)
4. Select US-East region  
5. Visit /auth/start to authenticate
6. Visit /debug/schwab to verify
7. Check /summary after first trade day
