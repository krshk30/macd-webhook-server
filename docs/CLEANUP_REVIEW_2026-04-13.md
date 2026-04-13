# Cleanup Review

Date: 2026-04-13

This note captures the first cleanup pass across the active Railway server code and the TradingView Pine script.

## Cleanup Completed

### Active Server

- Removed an unused `getTradeId` import from `src/services/positions.js`.
- Added a basic automated test suite using Node's built-in test runner.
- Added webhook route tests for auth, heartbeat, and blocked-entry behavior.
- Added webhook route tests for server-owned `SCALE` and `CLOSE` execution behavior.
- Hardened webhook parsing so `text/plain` bodies containing JSON are accepted and parsed before auth validation.
- Removed clearly non-active legacy runtime files from the repo root.
- Removed `src/server-patch.js`, which was a historical patch artifact rather than runtime code.

### TradingView Pine Script

- Removed unused variable `stochGreen`.
- Removed unused variable `exitReason`.
- Removed unused variable `exitSignal`.
- Updated the dashboard title from `Confirmed v3.3` to `Confirmed v3.4.2` so the visible version matches the file header.
- Replaced risky webhook number formats like `"#.0"` and `"#.##"` with JSON-safe helpers that preserve leading zeroes.

## Validation Completed

- All active JS files passed `node --check`.
- New automated tests passed with `npm test`.
- Installed declared npm dependencies in the local workspace so route-level tests could execute against the real Express router.
- Added Pine/server contract coverage to ensure the Pine file still emits:
  - `BUY`
  - `SCALE`
  - `CLOSE`
  - `HEARTBEAT`
- Added a root `.gitignore` so `node_modules/`, `.env`, runtime logs, and data files stay out of Git noise.
- Added regression coverage for plain-text TradingView webhook delivery and JSON-safe Pine alert formatting.

## Current Test Coverage

- `test/positions.test.js`
  - open position
  - scale position
  - close position
  - duplicate detection

- `test/pine-contract.test.js`
  - required TradingView action types exist
  - buy payload includes key analysis fields
  - heartbeat payload includes floor fields used by server protection logic

## Recommended Next Cleanup Step

If you want a stronger cleanup pass next, the safest follow-up would be:

1. Add tests around more webhook branches such as `SCALE` and `CLOSE`.
2. Review whether token persistence should be added for Railway restarts.
3. Add targeted coverage around Schwab service edge cases and retry/failure paths.
