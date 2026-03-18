# MACD Momentum Webhook Server v1.2.6

## v1.2.6: Anti-Short Protection
- Verifies actual Schwab position before ANY sell (CLOSE, SCALE, CANCEL_BUY)
- If no shares on Schwab, cleans tracker only — no sell order sent
- Uses Math.min(tracker qty, actual qty) to prevent overselling

## v1.2.5: No Brackets + CANCEL_BUY
- Simple BUY only — no bracket TP/SL orders
- CANCEL_BUY handler for Pine Script repaint detection
- Fixed cancelOrdersForTicker: raw axios, date range, all cancelable statuses

## Full Changelog
- v1.2.6: Anti-short protection (verify Schwab position before sell)
- v1.2.5: No brackets, CANCEL_BUY, fixed cancel orders
- v1.2.4: handleClose zero-quantity guard
- v1.2.3: 1-min orphan check, raw axios positions
- v1.2.2: /accounts endpoint for positions
- v1.2.1: Auth hash retry 3s delay
- v1.2: Extended hours LIMIT, orphan safety
- v1.1: Account hash, /debug/schwab
- v1.0: Core server, OAuth2
