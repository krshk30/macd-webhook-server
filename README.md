# MACD Momentum Webhook Server v1.2.5

## v1.2.5 Changes
- **CANCEL_BUY handler**: When Pine Script detects BUY repaint, sends CANCEL_BUY to server which immediately closes the position
- **No bracket orders**: Simple BUY only — Pine Script handles all exits via SCALE/CLOSE
- **Fixed cancelOrdersForTicker**: Uses raw axios, date range, all cancelable statuses
- All previous fixes included

## Actions
| Action | Description |
|--------|-------------|
| BUY | Simple market/limit buy |
| SCALE | Partial sell (50%, 75%, etc.) |
| CLOSE | Sell remaining shares |
| CANCEL_BUY | **NEW** — Repaint detected, close position immediately |
