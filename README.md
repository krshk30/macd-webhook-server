# MACD Momentum Webhook Server v1.2.7

## v1.2.7 Changes
- **LIMIT price buffer**: BUY at price+buffer, SELL at price-buffer for faster fills in extended hours
  - Configurable via `LIMIT_BUFFER_CENTS` env var (default: 0.02)
- **Fixed anti-short check**: Only verifies Schwab position on CANCEL_BUY (repaint)
  - CLOSE and SCALE trust the tracker — no more false "no shares" on pending LIMIT orders
  - CANCEL_BUY still checks because the BUY LIMIT may not have filled
- All v1.2.5 fixes: no brackets, CANCEL_BUY, fixed cancel orders, orphan checker

## Changelog
- v1.2.7: LIMIT buffer, anti-short only on CANCEL_BUY
- v1.2.6: Anti-short on all sells (too aggressive — reverted in v1.2.7)
- v1.2.5: No brackets, CANCEL_BUY, fixed cancelOrdersForTicker
- v1.2.4: handleClose zero-quantity guard
- v1.2.3: 1-min orphan, raw axios positions
- v1.2.2: /accounts for positions
- v1.2.1: Auth hash retry
- v1.2: Extended hours LIMIT, orphan safety
- v1.1: Account hash, /debug/schwab
- v1.0: Core server, OAuth2
