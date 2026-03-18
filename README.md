# MACD Momentum Webhook Server v1.2.2

TradingView alerts → Schwab Trader API → TOS execution.

## v1.2.2 Fix
- **Orphan checker 400 error resolved**: Now uses `/accounts` endpoint instead of `/accounts/{hash}?fields=positions`
- The single-account endpoint was returning 400 for Individual API apps
- `/accounts` returns all accounts with positions by default and works reliably

## Deploy
1. Push to GitHub → Railway auto-deploys
2. `/auth/start` to authenticate
3. `/debug/schwab` to verify
4. Logs should show clean orphan checks (no more 400 spam)

## Full Changelog
- **v1.2.2**: Fixed orphan/positions 400 — uses /accounts list endpoint
- **v1.2.1**: Auth hash retry with 3s delay, better error logging
- **v1.2**: Extended hours auto LIMIT, orphan safety net, session detection
- **v1.1**: Account hash auto-fetch, /debug/schwab diagnostic
- **v1.0**: Core server, OAuth2, bracket orders, position tracking
