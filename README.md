# MACD Momentum Webhook Server v1.2.8

## v1.2.8: Heartbeat Pattern for BUY Repaint Protection
- Pine Script sends HEARTBEAT every 30s while in position
- Server tracks lastSignalTime per position
- If no signal (heartbeat/scale/close) for 90s → BUY repainted → auto-close
- Any signal (BUY, SCALE, CLOSE, HEARTBEAT) resets the timer
- HEARTBEAT is lightweight — no logging, no dedup check

## Flow
```
BUY → lastSignalTime set
HEARTBEAT (30s) → lastSignalTime reset
HEARTBEAT (60s) → lastSignalTime reset  
BUY repaints → inPosition false → HEARTBEAT stops
90s timeout → server auto-closes position
```

## Env vars
- HEARTBEAT_TIMEOUT_SECS=90 (default)
- LIMIT_BUFFER_CENTS=0.02 (for extended hours)

## Changelog
- v1.2.8: Heartbeat pattern
- v1.2.7: LIMIT buffer, anti-short only on CANCEL_BUY  
- v1.2.5: No brackets, fixed cancelOrdersForTicker
- v1.2.4: handleClose zero-qty guard
