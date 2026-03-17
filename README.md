# MACD Momentum Webhook Server v1.2.1

TradingView alerts → Schwab Trader API → TOS execution.

## Changelog
- **v1.2.1**: Fixed orphan checker 400 errors (proper query params), auth callback 3s delay, better logging
- **v1.2**: Extended hours auto LIMIT orders, orphan position safety net, session detection
- **v1.1**: Account hash auto-fetch, /debug/schwab diagnostic endpoint
- **v1.0**: Core webhook server, OAuth2, bracket orders, position tracking

## Deploy to Railway
1. Push to GitHub (private repo)
2. Railway → New Project → Deploy from GitHub
3. Set environment variables (see .env.example)
4. Select US-East region
5. Visit /auth/start to authenticate
6. Visit /debug/schwab to verify

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| SCHWAB_CLIENT_ID | Yes | App Key from developer.schwab.com |
| SCHWAB_CLIENT_SECRET | Yes | Secret from developer.schwab.com |
| SCHWAB_ACCOUNT_ID | Yes | Your Schwab brokerage account number |
| SCHWAB_CALLBACK_URL | Yes | https://your-app.up.railway.app/auth/callback |
| WEBHOOK_TOKEN | Yes | Must match TradingView alert payloads |
| DEFAULT_QUANTITY | No | Shares per trade (default: 1000) |
| TP_CENTS | No | Take profit per share (default: 0.08) |
| SL_CENTS | No | Stop loss per share (default: 0.05) |
| ORPHAN_TIMEOUT_MINS | No | Auto-close orphan positions after N mins (default: 5) |
| MAX_POSITIONS | No | Max concurrent positions (default: 3) |
| MAX_DAILY_LOSS | No | Stop trading after this loss (default: -500) |
| TRADING_START_HOUR | No | Start hour ET (default: 7) |
| TRADING_END_HOUR | No | End hour ET (default: 18) |
| DISCORD_WEBHOOK_URL | No | Discord notifications |

## Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| / | GET | Service info |
| /health | GET | Health check, token status, positions |
| /positions | GET | Current open positions |
| /webhook | POST | Receive TV alerts (requires token) |
| /auth/start | GET | Start Schwab OAuth2 flow |
| /auth/callback | GET | OAuth2 callback (automatic) |
| /debug/schwab | GET | Test all Schwab API endpoints |

## Key Features
- **Extended hours**: Auto-detects pre/post market, uses LIMIT + SEAMLESS session
- **Orphan safety**: Checks Schwab every 2 min for positions without matching tracker (repainting fix)
- **Bracket orders**: TP/SL controlled by env vars
- **Token auto-refresh**: Every 25 min (tokens expire at 30 min)
- **Dedup filter**: 5-second window prevents duplicate order execution
- **Eastern timezone**: All trading hour checks use ET, not UTC
