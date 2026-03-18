# MACD Momentum Webhook Server v1.2.4

## v1.2.4: handleClose zero-quantity guard
- If all shares already sold via scale exits, CLOSE just cleans up the tracker
- No more "OrderLeg Quantity should not be zero" errors from Schwab

## Full Changelog
- v1.2.4: handleClose zero-quantity fix
- v1.2.3: 1-min orphan check, raw axios positions, bracket skip ext hours
- v1.2.2: /accounts endpoint for positions
- v1.2.1: Auth hash retry 3s delay
- v1.2: Extended hours LIMIT, orphan safety
- v1.1: Account hash, /debug/schwab
- v1.0: Core server, OAuth2, bracket orders
