# MACD Momentum Webhook Server

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

1. Push this repo to GitHub
2. Create new Railway project → Deploy from GitHub repo
3. Set environment variables (see below)
4. Select **US-East (Virginia)** region
5. Deploy
6. Visit `https://your-app.up.railway.app/health` to verify
7. Visit `https://your-app.up.railway.app/auth/start` to authenticate with Schwab

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

## TradingView Alert Setup

Set webhook URL to: `https://your-app.up.railway.app/webhook`

### BUY Alert Message:
```json
{"action":"BUY","path":"P1_MACD","ticker":"{{ticker}}","price":{{close}},"volume":{{volume}},"time":"{{time}}","token":"your-secret-token"}
```

### SCALE 2% Alert Message:
```json
{"action":"SCALE","level":"PCT2","sell_pct":50,"ticker":"{{ticker}}","price":{{close}},"time":"{{time}}","token":"your-secret-token"}
```

### SCALE FAST 4% Alert Message:
```json
{"action":"SCALE","level":"FAST4","sell_pct":75,"ticker":"{{ticker}}","price":{{close}},"time":"{{time}}","token":"your-secret-token"}
```

### SCALE 4% after 2% Alert Message:
```json
{"action":"SCALE","level":"PCT4_AFTER2","sell_pct":75,"ticker":"{{ticker}}","price":{{close}},"time":"{{time}}","token":"your-secret-token"}
```

### CLOSE Alert Message:
```json
{"action":"CLOSE","reason":"MACD_BEAR","ticker":"{{ticker}}","price":{{close}},"time":"{{time}}","token":"your-secret-token"}
```

## Token Refresh

- Access tokens expire every **30 minutes**
- Server auto-refreshes at **25-minute** mark
- Refresh tokens expire every **7 days** — you must re-authenticate weekly
- Visit `/auth/start` to re-authenticate when refresh token expires
- Server sends Discord alert if refresh fails
