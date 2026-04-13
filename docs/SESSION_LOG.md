# Session Log

This file is the running record of repository analysis and updates for the current Codex-assisted cleanup session.

## 2026-04-13

- Reviewed the architecture document at `C:/Users/kkvkr/Downloads/Stock Momentum Project/MACD_Momentum_Automated_Trading_Architecture.docx`.
- Inspected the repository layout and confirmed the active application lives under `src/`.
- Compared the architecture document with the implemented Node server and identified key differences:
  - persistence and journaling are implemented
  - heartbeat expiry and floor monitoring are implemented
  - the Pine script is not tracked in this repo yet
  - legacy root-level files still exist
- Verified there is currently no TradingView Pine script file in this repository.
- Rewrote `README.md` so it reflects the actual `src/`-based implementation and current webhook flow.
- Added `docs/PROJECT_STATE.md` to capture the current architecture, implementation status, and drift from the original design document.
- Added `tradingview/README.md` as the canonical place to store the TradingView Pine script once provided.
- Updated `env.example` to better match the current server configuration surface without touching any real secret values.
- Reviewed the final diff and confirmed this pass updates documentation and workspace structure only, not runtime trading logic.
- Imported the TradingView Pine script into `tradingview/macd-momentum-alerts-v3.4.2_1.pine`.
- Created a fresh architecture document that reflects the current Pine script plus the active Railway server implementation.
- Added `npm test` using Node's built-in test runner.
- Added test coverage for the position tracker and the Pine/server webhook contract.
- Removed one unused import in the active server code and three unused variables in the Pine script.
- Added `docs/CLEANUP_REVIEW_2026-04-13.md` to record completed cleanup and remaining candidates.
- Added webhook route tests for invalid token, auth unavailable, heartbeat, and blocked BUY behavior.
- Removed the old root-level runtime files and `src/server-patch.js` so the repo now points cleanly at the active `src/` server.
- Installed npm dependencies in the local workspace because route-level tests required the declared Express dependency to be present.
- Added a root `.gitignore` to keep `node_modules/`, runtime logs, and local data out of Git tracking.
- Clarified the intended architecture: Pine is the signal/visual layer and the server is the execution/fail-safe layer, so the server should not mirror Pine-only strategy rules.
- Added route-level tests for the server-managed `SCALE` and `CLOSE` flows.
- Investigated a real TradingView `401 Unauthorized` webhook incident for `JDZG` and traced it to invalid JSON number formatting in Pine alert payloads such as `.0` and `-.5`.
- Fixed Pine webhook number formatting to use JSON-safe leading-zero masks and added a regression test to keep risky `"#."` alert formatting out of webhook payloads.
- Hardened the server to parse `text/plain` webhook bodies as JSON when possible, preventing text/plain TradingView deliveries from being misreported as token failures.
- Added route-level test coverage for plain-text JSON webhook delivery.
- Investigated repeated after-hours `BUY+STOP` failures on Schwab for names such as `JDZG` and `GCTK` and confirmed the failing pattern was the composite entry-plus-stop order shape during `SEAMLESS` sessions.
- Reworked server entry handling so live `BUY` requests now use plain entry orders, with extended-hours limit buys tracked as pending entries until Schwab account positions confirm a real fill.
- Added a pending-entry monitor to the server startup flow so after-hours fills can be activated automatically without creating phantom local positions.
- Shifted price-based risk handling to the server monitor:
  - hard stop is now server-managed
  - profit-floor ratcheting is now virtual/server-managed
  - price-based scale milestones can be executed server-side
- Rewrote the webhook route to support pending-entry cancellation on `CLOSE`, milestone-aware scale deduplication, and safer local state updates only after sell requests succeed.
- Expanded tests to cover pending-entry lifecycle, server-managed scale deduplication, and pending-close cancellation.
- Updated `env.example` and the architecture document to reflect the new pending-entry and server-managed protection model.

## Ongoing Rule For Future Sessions

- Record meaningful analysis, file updates, and architecture decisions here whenever changes are made.
- Keep TradingView payload structure and backend expectations synchronized and note those changes here.
