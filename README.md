# MACD Momentum Webhook Server v1.1

TradingView alerts → Schwab Trader API → TOS execution.

Target latency: **<500ms** from alert to order fill.

## Architecture

```
TradingView (30s chart)
    │ webhook POST (JSON)
    ▼
Railway Server (US-East)
    │ REST API call
    ▼
Schwab Trader API
    │
    ▼
TOS / Exchange fill
```

## Quick Deploy to Railway

1. Push this repo to GitHub (private repo)
2. Create new Railway project → Deploy from GitHub repo
3. Set environment variables (see below)
4. Select **US-East (Virginia)** region
5. Deploy
6. Visit `https://your-app.up.railway.app/health` to verify
7. Visit `https://your-app.up.railway.app/auth/start` to authenticate with Schwab
8. Visit `https://your-app.up.railway.app/debug/schwab` to verify all endpoints work

## Environment Variables

Set these in Railway's Variables tab:

| Variable | Required | Description |
|----------|----------|-------------|
| `SCHWAB_CLIENT_ID` | Yes | App Key from developer.schwab.com |
| `SCHWAB_CLIENT_SECRET` | Yes | Secret from developer.schwab.com |
| `SCHWAB_ACCOUNT_ID` | Yes | Your Schwab brokerage account number |
| `SCHWAB_CALLBACK_URL` | Yes | `https://your-app.up.railway.app/auth/callback` |
| `WEBHOOK_TOKEN` | Yes | Secret token (must match TV alert payloads) |
| `DEFAULT_QUANTITY` | No | Shares per trade (default: 1000) |
| `MAX_POSITIONS` | No | Max concurrent positions (default: 3) |
| `MAX_DAILY_LOSS` | No | Stop trading after this loss (default: -500) |
| `TP_CENTS` | No | Take profit per share (default: 0.08) |
| `SL_CENTS` | No | Stop loss per share (default: 0.05) |
| `TRADING_START_HOUR` | No | Start hour EST (default: 7) |
| `TRADING_END_HOUR` | No | End hour EST (default: 16) |
| `DISCORD_WEBHOOK_URL` | No | Discord channel webhook for notifications |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check, token status, positions |
| `/positions` | GET | Current open positions |
| `/webhook` | POST | Receive TV alerts (requires token) |
| `/auth/start` | GET | Start Schwab OAuth2 flow |
| `/auth/callback` | GET | OAuth2 callback (automatic) |
| `/debug/schwab` | GET | **Test all Schwab API endpoints** |

## Troubleshooting: 500 on /accounts/accountNumbers

If you get a 500 error when placing orders:

1. Visit `/debug/schwab` — it will test all endpoints and tell you exactly what's broken
2. Most common cause: token was created before app was "Ready For Use"
3. Fix: re-authenticate via `/auth/start`
4. During Schwab login, make sure you SELECT your brokerage account
5. After auth, the server auto-fetches and stores your account hash

## v1.1 Changes

- Added `/debug/schwab` diagnostic endpoint
- Auto-fetches account hash after OAuth authentication
- Uses account hash (not raw account number) for API calls
- Improved auth callback page with troubleshooting links
