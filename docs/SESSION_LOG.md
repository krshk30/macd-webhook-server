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
- Investigated a production `RMSG` incident where a filled extended-hours entry stayed marked as pending, so the hard-stop/floor monitor never watched it and a later `CLOSE` cleared the pending record instead of selling the live shares.
- Confirmed the failure path from logs:
  - `BUY` created a pending entry
  - no activation happened before `CLOSE`
  - `cancelOrder` returned `400`, consistent with an already-filled order
  - the route still cleared the pending record
- Hotfixed pending-entry promotion to check the Schwab order details endpoint for fills, not just account positions.
- Hotfixed `CLOSE` so a pending entry is re-checked for fill status before it is ever cleared, including a retry path after cancel failure.
- Added regression tests for:
  - filled pending entry closes correctly
  - cancel failure triggers order-detail re-check before clearing
- Investigated a second production safety issue where the orphan checker imported unrelated manual Thinkorswim positions and later auto-closed them as `ORPHAN_AUTO_CLOSE`.
- Locked broker orphan import behind a new env flag `ENABLE_BROKER_ORPHAN_IMPORT`, defaulting to `false`, so the server now only manages positions it created or restored from its own persisted state unless broker import is explicitly enabled.

## 2026-04-14

- Reconstructed the full `BTBD` trade from Railway logs and TradingView alert screenshots:
  - entry `10 @ 1.9797`
  - server-managed `PCT2` scale sold `5`
  - server-managed `PCT4_AFTER2` scale sold `2`
  - final `3` shares were closed by `HEARTBEAT_EXPIRED`
- Confirmed TradingView's attempted `FLOOR_BREACH` close for `BTBD` still used malformed numeric JSON (`stochK:.0`), which means the TradingView site was likely running an older Pine copy instead of the JSON-safe repo version.
- Identified a real server-side floor mismatch:
  - the server ratcheted `currentStopPrice` upward
  - but floor breach checks still recalculated floor from current profit, allowing the effective floor to loosen on pullbacks
  - this diverged from Pine's peak-based sticky floor behavior
- Fixed server floor monitoring so breach checks now use the sticky ratcheted stop as the active floor threshold and never loosen on pullbacks.
- Added `test/schwab-floor.test.js` to lock in the sticky-floor behavior with regression coverage for the `BTBD`-style pullback case.
- Replaced the old fixed `2¢` hard stop with a price-scaled `1%` hard stop plus a `1¢` minimum floor so higher-priced names such as `ROLR` are not stopped out by sub-0.3% pullbacks.
- Reviewed whether the new universal `1%` hard stop is the right long-term setting:
  - conclusion: `1%` is a reasonable starting default and clearly better than a universal fixed-cent stop
  - concern: it is still likely too tight for some higher-volatility names and too rigid across different volatility regimes
  - research direction to revisit in evening trade review: keep `1%` as baseline for now, but consider a future volatility-aware stop model using ATR/ATRP or a simple regime switch rather than one static percentage for every ticker and market condition
- Updated the Pine script to reduce missed continuation names such as `SNAL` without removing the VWAP safeguard entirely:
  - `P1_CROSS` and `P2_VWAP` still respect the normal session VWAP max-distance gate
  - `P3_SURGE` can now bypass the normal VWAP cap only when a controlled high-VWAP continuation override is satisfied
  - the override requires price to remain tight to EMA9, EMA9 above EMA20, and EMA9 rising, with a separate hard upper cap on VWAP extension
- Extended the Pine continuation logic again for low-float news/catalyst moves:
  - added a `P3`-only momentum override for cases where session VWAP is not the main blocker
  - the new override can bypass the normal StochK and EMA9 stretch caps when momentum, EMA structure, and volume expansion remain strong
  - this is specifically intended to catch the first strong continuation leg in low-float names without globally weakening the entry gates for `P1` and `P2`
- Added a paired TradingView strategy file, `tradingview/macd-momentum-strategy-v3.4.4.pine`, so backtest/export results can be reviewed alongside the live indicator logic.
- Adopted a standing workflow for Pine maintenance: whenever the live indicator changes, update the paired strategy file in the same pass.
- Added a completely separate TradingView strategy, `tradingview/spike-scalp-strategy-v1.pine`, to test low-float catalyst spike-pullback scalps without changing the main MACD momentum indicator or its paired backtest strategy.
- The new spike-scalp strategy uses its own rule set:
  - arm after an abnormal 3-bar spike with strong relative volume and positive MACD structure
  - wait for the first 1-3 bar pullback that stays orderly
  - enter on reclaim above EMA9 and prior-bar high
  - exit with a dedicated stop, spike-high partial, and fast EMA9 / ATR / time-stop logic
- Reset `tradingview/spike-scalp-strategy-v1.pine` to a much simpler baseline after real-chart review showed the first structured version was overfitting low-float names too early.
- The new baseline version intentionally removes EMA, MACD, and pullback-structure gating so we can study raw behavior first:
  - entry on simple `3`-bar spike + relative volume + prior-bar-high break
  - stop at prior bar low
  - fixed `5%` target
  - hard time exit after `5` bars
- Relaxed the baseline spike scalp again after live chart review showed the breakout often happens a few bars after the spike, not on the same bar:
  - the strategy now detects a recent qualifying spike first
  - then allows entries for a short configurable window after that spike
  - added separate `SPIKE` and `SET` markers so chart review can distinguish detection from actual trade entry
- Tightened the 30-second post-spike entry window from `5` bars to `2` bars after reviewing the user's low-float workflow:
  - keep the spike detector frozen for now
  - reduce late entries that arrive after the clean impulse is already gone
  - use this as the 30-second baseline before comparing against any future faster-timeframe variant
- Simplified the post-spike entry trigger again to match the user's baseline-testing plan:
  - after a detected `SPIKE`, allow entry within the next `2` bars
  - entry now only requires a simple continuation break of the prior bar high
  - no extra EMA, MACD, or volume filters are used on the `SET` trigger
  - moved the `SET` marker above the bar so it is visually distinct from the `SPIKE` marker during chart review
- Fixed a critical baseline-strategy bug after TradingView review showed only one historical trade across the whole sample:
  - `oneTradePerSession` was not resetting correctly across days because the previous stored bar was often still inside the prior day's session
  - switched the reset logic to a day-change reset so each new trading day can produce fresh entries
- Rewrote `tradingview/spike-scalp-strategy-v1.pine` around an anchored impulse-candle model after reviewing user-marked SNAL screenshots and exported bar data:
  - removed the rolling multi-bar spike detector
  - a setup now begins with a single impulse bar only
  - the impulse bar must show strong one-candle expansion, close near the high, relative volume, and a break of recent highs
  - the setup is then frozen to that candle's high/low
  - entry is only allowed on the next few bars if price breaks the frozen impulse high
  - added explicit `ENTRY` and `EXIT` fill markers so chart visuals line up with Strategy Tester trades
- Removed the single-trade-per-day restriction from the standalone spike strategy so it can collect many examples in one session for research:
  - `SPIKE` detection stays the same
  - anchored impulse setup stays the same
  - the strategy no longer disables itself after the first fill of the day
- Started the first post-baseline trade-management pass on the standalone spike strategy without adding any new entry qualifiers:
  - added a max-stop cap so losses cannot run as wide as the full impulse candle on bad entries
  - added one simple partial scale-out before the final target so profitable moves can realize gains earlier
  - intentionally deferred MACD / EMA / VWAP / histogram qualifiers so we can isolate the effect of risk management first
- Added a local CSV simulator at `tools/simulate-spike-scalp.js` so TradingView chart-data exports can be replayed directly inside the repo without relying on manual TradingView strategy inspection every time.
- The simulator reads exported OHLC + signal columns, replays entries/exits with configurable stop/scale/target settings, and prints a flat trade table plus summary metrics for quick comparison of ideas like tighter stop caps.
- Updated the standalone spike strategy default max-stop cap from `4%` to `2%` at the user's request while keeping the partial scale logic active.
- Replaced the standalone spike strategy's temporary fixed-profit exit model with the same back-half logic used by the real TradingView/Railway system:
  - scales at `2%`, `FAST4`, and `4% after 2%`
  - tiered Stoch exits
  - MACD bear exit
  - sticky profit-floor breach exit
  - optional time stop left as a safety override only
- Archived the current standalone spike strategy snapshot at `tradingview/archive/spike-scalp-strategy-v1-2026-04-14-anchored-impulse-live-exit.pine` so future experiments can always roll back to the first anchored-impulse version with live-style exits.
- Ran a deeper research pass on low-float momentum/news scalps after the standalone spike strategy produced many hard-stop exits:
  - external research and exchange/broker guidance reinforce that news-driven continuation is real, but extended-hours and low-priced names are especially vulnerable to exaggerated and unsustainable spikes because of wider spreads, thinner liquidity, and more violent post-news volatility
  - recreated earlier SNAL simulations and confirmed the recent deterioration came mostly from tighter exit/risk settings, not a different entry detector
  - the next bottleneck is now entry quality rather than exit complexity
  - best next filters to test one at a time are not "more of everything", but likely:
    - freshness / first-impulse filter
    - impulse quality / close-near-high filter
    - acceleration qualifier such as rising MACD histogram or improving MACD delta
    - short post-impulse continuation rule that avoids buying straight into the most vertical candle
- Updated `tradingview/spike-scalp-strategy-v1.pine` with the first two entry-quality filters from that research pass:
  - freshness filter: reject a new impulse if another impulse was detected too recently
  - mandatory one-bar pause: the first bar after the impulse must stay below the impulse high, and entry is only allowed after that pause confirms
- Loosened the standalone spike strategy freshness default from `12` bars to `4` bars after live TradingView review showed the initial combined filter set cut the sample from `9` trades down to only `2`, which was too restrictive for low-float names on a `30s` chart.
- Archived the freshness/pause experiment at `tradingview/archive/spike-scalp-strategy-v1-2026-04-14-freshness-pause-experiment.pine`.
- Restored `tradingview/spike-scalp-strategy-v1.pine` to a simpler baseline after review showed the live-style exit path plus freshness/pause filters were no longer producing a useful research baseline:
  - anchored impulse detector remains
  - no freshness filter
  - no mandatory pause filter
  - no live-style scale/floor/MACD/Stoch exits
  - simple management only: impulse breakout entry, anchor stop, fixed profit target, time stop
- Switched baseline review from the extreme `SNAL` outlier to a more normal intraday momentum name, `ROLR`, after the user pointed out `SNAL` was a several-hundred-percent anomaly and not representative of a normal day.
- Stored the `ROLR` chart export at `tradingview/samples/BATS_ROLR_1_2026-04-14.csv` and confirmed the restored baseline generates a much cleaner, more believable sample on that symbol, with only two trades and both broadly in line with the user's TradingView screenshots.
- Added a separate experimental strategy, `tradingview/spike-scalp-early-accel-strategy-v1.pine`, to test the user's earlier-entry idea without disturbing the restored baseline:
  - enter on the impulse bar itself instead of waiting for the later breakout bar
  - qualify that impulse with early MACD acceleration rather than the later MACD crossover
  - first-pass qualifiers are intentionally limited to:
    - histogram rising
    - MACD/signal gap shrinking
    - histogram still below zero (early pre-cross bias)
    - close above EMA9
    - EMA9 rising
  - exits are kept simple (`HARD_STOP`, `TARGET`, `TIME_STOP`) so entry quality remains the thing under test
- Added on-chart debug markers to the early-accel strategy so each impulse bar can show which qualifier blocked it:
  - `HIST`
  - `GAP`
  - `EMA`
  - `SLOPE`
  - plus `OK` when the acceleration stack passes but the strategy still does not enter
- Updated the early-accel strategy to match the user's clarified trading idea:
  - the spike is the actual trigger
  - histogram sign itself is no longer a blocker
  - removed the old `histogram below zero` gate so impulses can qualify whether the histogram is still slightly negative or already positive, as long as the acceleration/context rules are satisfied
- Loosened the early-accel `GAP` qualifier from a two-bar compression requirement to a one-bar requirement after chart review showed valid-looking spikes were often blocked even though the next bars continued well.
- Removed the `GAP` qualifier entirely from the early-accel strategy after further chart review and Thinkorswim-script comparison suggested it was too theoretical as a hard blocker for this scalp setup.
- The early-accel experiment is now intentionally simpler:
  - spike is the trigger
  - histogram rising is the main momentum qualifier
  - EMA context (`close > EMA9`, `EMA9 rising`) remains
  - no MACD-gap blocker
- Added a second entry path inside `tradingview/spike-scalp-early-accel-strategy-v1.pine` instead of creating a separate strategy:
  - `SPIKE_ACCEL` path remains the first-impulse entry
  - `REACCEL` path is for the user's "reset then re-acceleration" setup:
    - recent bearish MACD cross
    - histogram still negative
    - negative histogram starts contracting for 2-3 bars
    - close near/above EMA9
    - EMA9 rising
    - break of recent 2-bar high
  - added separate `EARLY` and `RE2` markers on chart so the two paths can be reviewed visually
- Added a single isolated trade-management change to the early-accel base:
  - `FAST_FAIL`
  - if the trade has not reached at least a small minimum profit after a small number of bars, exit early instead of waiting for the full time stop
  - this was added specifically to clean up weak stalls without changing the entry logic
- Backed out the `FAST_FAIL` experiment from the early-accel strategy after review of the `AGAE` sample showed it hurt results rather than helped:
  - it turned at least one weak stall into a worse realized loss than the previous `TIME_STOP`
  - the two-path entry structure remains
  - `SPIKE_ACCEL` vs `REACCEL` quality remains the next thing to improve
- Added one small `SPIKE_ACCEL`-only entry-quality filter to the early-accel strategy:
  - new input `Spike Max % Above EMA9`, default `3.0`
  - applies only to the first-impulse `SPIKE_ACCEL` path
  - rejects impulse bars that are already too extended above EMA9 while leaving `REACCEL` untouched
  - added debug marker `EXT` so chart review can show when the new EMA-distance cap blocks a spike
- Reworked the early-accel exit model from a full fixed target into a partial-plus-runner structure:
  - removed the old full-position fixed `5%` target exit
  - added `Scale 1 Target %`, default `2.0`
  - added `Scale 1 Sell %`, default `50`
  - after the first scale, the remaining runner exits on:
    - close below `EMA9`, or
    - histogram rolling down for a configurable number of bars
  - `TIME_STOP` now only applies before the first scale, so healthy runners can continue instead of being forced out too early
  - added chart marker `S2` for the first scale event
- Backed out the temporary `SPIKE_ACCEL`-only EMA-distance cap after review showed it reduced the sample from the earlier 10-trade behavior down to only 5 trades on the AGAE run.
- Current early-accel working state is now:
  - prior 10-trade entry behavior restored
  - new partial-plus-runner exit model kept in place
- Replaced the temporary custom `S2 + RUNNER_EXIT` back-half management in the early-accel strategy with a closer match to the main momentum script's style:
  - `PCT2`: partial scale at `+2%`
  - `FAST4`: fast partial at `+4%` before `PCT2`
  - `PCT4_AFTER2`: second scale at `+4%` after `PCT2`
  - ratcheting profit floor based on peak profit
  - final close on `FLOOR_BREACH` or `MACD_BEAR`
  - `TIME_STOP` remains optional safety only (`0 = OFF`)
  - added chart markers `S2`, `F4`, `S4`, `FLR`, and `MB`
- Added a clean comparison variant inside the same early-accel strategy by stripping the momentum-style exit stack back to pure signal exits only:
  - removed all scales
  - removed the profit floor
  - exits are now:
    - `MACD_BEAR`
    - `STOCHK_EXIT`
    - `HARD_STOP` safety
    - optional `TIME_STOP`
  - added `STOCHK_EXIT` marker `SK`
  - purpose: test whether price-based floor/scale logic is the reason the scalp strategy exits earlier than the older momentum indicator
- Loosened only the `REACCEL` path so it can trigger when price gets back near `EMA9` before `EMA9` itself has fully turned higher:
  - added separate `Reaccel: Require EMA9 Rising` input
  - default is now `OFF`
  - `SPIKE_ACCEL` still keeps its original EMA-slope requirement
  - purpose: capture the user's "negative histogram reset then reclaim near EMA9" setup earlier, before the full MACD/EMA turn is already obvious
- Added a third entry path inside the same early-accel strategy:
  - `REACCEL_EARLY`
  - intent: catch the user's "price is reclaiming toward EMA9 while still under it" setup before the more obvious breakout above EMA9
  - logic uses the same reset context:
    - recent bearish MACD cross
    - negative histogram bottomed and rising
    - price near EMA9
  - but allows entry while still at or under EMA9 if the candle is reclaiming and breaking a very short recent high
- Upgraded on-chart path labels in the early-accel strategy so the three path families are easier to read:
  - `SPIKE`
  - `SPIKE ACCEL`
  - `REACCEL`
  - `REACCEL EARLY`
- Cleaned up the early-accel strategy chart labeling to behave more like the momentum indicator:
  - raw setup-signal labels are now hidden by default
  - chart now emphasizes actual fill labels only
  - entry labels show the path plus filled size and price
  - exit labels show the exit reason plus closed size, price, and approximate P&L %
  - purpose: reduce noisy overlapping markers and make live chart review easier
- Replaced the split `REACCEL` / `REACCEL_EARLY` logic with one unified `REACCEL WATCH` family in the early-accel scalp strategy:
  - `SPIKE_ACCEL` remains unchanged
  - `REACCEL` now watches only the first `5` bars after a recent bearish MACD cross
  - requires histogram to remain negative and show improvement on at least `2` of the last `3` bars
  - requires current histogram to recover at least `50%` from the recent negative trough toward zero
  - requires price to be within `0.35%` of `EMA9`
  - requires a green reclaim candle closing in the top `40%` of its range
  - requires a break of the prior bar high
  - requires current volume to be at least the previous bar's volume and at least `1.25x` the 5-bar average
  - only one `REACCEL` entry is allowed per bearish-reset cycle
- Loosened only the unified negative-histogram `REACCEL` watch thresholds after reviewing missed reset/reclaim entries on AGAE:
  - `Histogram Recovery % From Trough`: `50 -> 25`
  - `Close Within % Of EMA9`: `0.35 -> 0.50`
  - `Volume x 5-Bar Avg`: `1.25 -> 1.10`
  - `SPIKE_ACCEL` was intentionally left unchanged so positive-histogram continuation spikes still belong to the spike path, while `REACCEL` focuses only on negative-histogram reset entries
- Further loosened only the unified `REACCEL` watch after the first relaxation still produced zero reaccel entries on AGAE:
  - `Watch Bars After Bear Cross`: `5 -> 7`
  - removed the separate `volume >= previous bar` gate from `REACCEL`
  - all other `SPIKE_ACCEL` and `REACCEL` conditions remain unchanged
- Removed the strict `histogram must still be negative` gate from the unified `REACCEL` watch to test whether missed second-leg continuation entries were being blocked simply because the histogram had already reached or crossed the zero line:
  - `recent bearish MACD cross` remains required
  - histogram improvement, trough recovery, EMA9 proximity, candle quality, breakout, and 5-bar volume confirmation still remain in place
  - `SPIKE_ACCEL` remains unchanged
- Removed the `recent bearish MACD cross` requirement from the unified `REACCEL` watch as a separate experiment after observing that it could conflict with the newer histogram/trough-recovery logic:
  - `REACCEL` is now driven only by histogram improvement, trough recovery, EMA9 proximity, candle quality, breakout, and 5-bar volume confirmation
  - the old one-entry-per-bear-cross-cycle guard was removed along with it
  - `SPIKE_ACCEL` remains unchanged
- Relaxed the `REACCEL` reclaim trigger after confirming the path was alive but still missing too many reclaim entries:
  - added `Require Break Prior Bar High` as a dedicated `REACCEL` input
  - default is now `OFF`
  - all other `REACCEL` gates remain unchanged for this test
- With `SPIKE_ACCEL` frozen, loosened only the `REACCEL` reclaim-candle quality gate:
  - `Reaccel Close In Top % Of Range`: `40 -> 60`
  - purpose: allow valid reclaim bars that do not finish extremely near the high, while keeping the rest of the `REACCEL` gates unchanged
- Added TradingView tooltips to all `REACCEL` inputs so the user can adjust those thresholds directly in Settings without repasting code:
  - watch bars
  - histogram recovery %
  - EMA9 distance %
  - close-in-range %
  - 5-bar volume multiple
  - green-candle requirement
  - prior-bar-high requirement
- Updated the live Railway Pine alert script to stop sending TradingView `SCALE` webhooks:
  - kept `BUY`, `HEARTBEAT`, and `CLOSE` alerts
  - removed TradingView `FAST4`, `PCT2`, and `PCT4_AFTER2` alert payloads
  - reason: prevent duplicate scale-outs when server-managed scales are enabled and faster than webhook-driven scales
- Added a first lightweight `CONTINUATION` path to the spike scalp strategy:
  - `SPIKE_ACCEL` left unchanged
  - `REACCEL` disabled by default for cleaner testing
  - `CONTINUATION` looks for a second push within `6` bars after a recent spike/impulse
  - requires price above/near `EMA9`, non-falling `EMA9`, positive/non-falling histogram, green candle, 5-bar volume confirmation, and a short recent-high break
- Refined continuation timing controls after it fired too close to the original spike:
  - added `Min Bars After First Spike` input (default `2`)
  - widened `Bars After First Spike` from `6` to `8`
  - purpose: avoid immediate one-bar follow-through entries while still allowing a later second-push continuation
- Reworked the `CONTINUATION` path to match the newer pause-based structure recommendation:
  - continuation is no longer measured from the first spike bar itself
  - a recent spike/impulse now arms a short search for the first pause bar
  - first pause bar is defined simply as a red bar or an inside bar
  - continuation window now starts from that pause bar, not from the spike start
  - continuation trigger is now a break above the pause-bar high instead of a generic recent `2`-bar high
  - existing guardrails were intentionally left in place for this first test:
    - `EMA9` not falling
    - histogram above zero and not lower than the previous bar
    - green breakout candle
    - `5`-bar relative-volume filter
- Relaxed only the `CONTINUATION` histogram gate after outside review of AGAE showed the strongest missed second-push bars were being blocked mainly because the histogram was still slightly negative while already turning up:
  - added `Require Histogram Above 0` as a continuation input
  - default is now `OFF`
  - continuation still requires histogram to be non-falling (`histValue >= histValue[1]`)
  - purpose: allow earlier second-push entries without loosening the other continuation guardrails yet
- Updated the next `CONTINUATION` test after further outside review of the AGAE continuation misses:
  - `Require Histogram Above 0` default changed back to `ON`
  - removed the hard `histValue >= histValue[1]` continuation eligibility rule
  - continuation now only uses histogram sign (`> 0`) as the guardrail, not one-bar histogram slope
  - added a debug marker `H-` to show bars that would have been blocked by the old histogram-slope rule while still passing the rest of the continuation filters
- Tightened the `CONTINUATION` structure to use a small pause/base instead of a single pause bar:
  - added `Base Bars` input, default `2`
  - continuation still starts from the first pause after a spike, but now requires a `2`-bar base before it can fire
  - continuation breakout now uses the evolving base high instead of a one-bar pause high
  - purpose: move continuation away from immediate spike follow-through and closer to the intended "impulse -> hold -> second push" shape
- Added a `CONTINUATION` handoff experiment to test whether open-position overlap with `SPIKE_ACCEL` is the real blocker:
  - new input `Enable Continuation Handoff`, default `ON`
  - if a valid continuation setup appears while a `SPIKE_ACCEL` trade is still open, the strategy now converts that active trade into a continuation instead of waiting for a separate flat-to-entry cycle
  - on the handoff bar, normal exit checks are skipped once so the spike trade is not immediately closed before the continuation can take over
  - added on-chart `CONT HANDOFF` marker for visual review
- Added the first minimal `TREND_SCALP` path after broader review of `ASTI` and `AGAE` showed the strategy had no coverage for smoother staircase trend days:
  - `SPIKE_ACCEL` kept intact as the burst/first-punch path
  - `TREND_SCALP` is price-structure first:
    - `EMA9` rising for a configurable number of bars (default `3`)
    - close above `EMA9`
    - green breakout candle
    - light relative-volume check versus the `5`-bar average (default `1.00x`)
    - `2`-bar shelf/base by default
    - breakout bar must close above shelf high
    - shelf must remain tight within a configurable % width
  - purpose: cover grinder/stair-step small-cap days like `ASTI` without depending on one explosive first spike
- Added one simple trend-quality filter to `TREND_SCALP` after the first ASTI run showed it could identify the grinder, but was also entering some flatter late-day shelves:
  - new inputs:
    - `Prior Leg Lookback Bars`
    - `Prior Leg Min %`
  - `TREND_SCALP` now requires a recent upward leg of at least the configured size into the shelf before breakout can trigger
  - purpose: keep true staircase re-entries while filtering shelves that form without a meaningful prior push
- Backed out the `TREND_SCALP` prior-leg filter after testing on `ASTI` showed it was too strict and reduced the path to zero trades:
  - the simpler shelf-based `TREND_SCALP` remains
  - conclusion: a fixed recent-low-to-current-close % filter is too blunt for grinder names on a `30s` chart
  - next trend-path improvements should focus on shelf quality, not forcing a large prior expansion leg
- Rewrote `TREND_SCALP` around the TOS-style regime concept after reviewing the user's Thinkorswim reference:
  - removed the earlier `EMA9 rising for N bars` requirement from the trend path
  - trend regime is now defined by:
    - `EMA9 > EMA21`
    - `EMA21` rising over a configurable lookback
    - above `VWAP` or a fresh cross above `VWAP`
    - minimum distance from `VWAP` to avoid dead chop
  - kept the shelf breakout structure as the trigger:
    - close above `EMA9`
    - green breakout candle
    - light `5`-bar relative-volume check
    - tight `2`-bar shelf by default
    - breakout close above shelf high
  - purpose: make `TREND_SCALP` more trend-regime aware for smoother grinder names like `ASTI`
- Added a `TREND_SCALP` cooldown after the first ASTI run with the new trend regime produced useful grinder entries but too many clustered re-entries:
  - new input `Cooldown Bars`, default `6`
  - after any `TREND_SCALP` exit, the path now waits the configured number of bars before allowing another `TREND_SCALP` entry
  - purpose: keep the good grinder captures while cutting the weaker back-to-back shelf entries in flatter or later-day structure
- Expanded the `TREND_SCALP` `Shelf Bars` input range from `2-3` to `2-4` after live ASTI review showed `3` bars materially improved trade quality and the user wanted to test whether a `4`-bar shelf would clean the path further.
- Added a `TREND_SCALP` breakout candle quality filter after outside review suggested the remaining weak ASTI entries were more about weak breakout bars than bad shelf detection:
  - new input `Breakout Close Ratio`, default `0.60`
  - the trend breakout bar must now close in the upper part of its own range
  - purpose: keep stronger staircase breakout candles while filtering "poke above shelf then fade" entries
- Reset the built-in `TREND_SCALP` defaults in the Pine file to the baseline the user preferred after live ASTI testing:
  - `Shelf Bars = 3`
  - `Breakout Close Ratio = 0.60`
  - `EMA21 Slope Lookback = 5`
  - `Cooldown Bars = 0`
  - reason: keep the file defaults aligned with the working baseline instead of the later cooldown experiment
- Froze the current `TREND_SCALP` baseline defaults after the user identified the preferred ASTI grinder settings:
  - `Shelf Bars = 3`
  - `Shelf Tightness % = 0.60`
  - `Volume x 5-Bar Avg = 1.00`
  - `Breakout Close Ratio = 0.60`
  - `EMA21 Slope Lookback = 5`
  - `Require Above VWAP = OFF`
  - `Allow VWAP Cross Entry = ON`
  - `Min VWAP Distance % = 0.00`
  - `Cooldown Bars = 0`
  - purpose: preserve the working grinder baseline and avoid losing it through manual TradingView setting drift
- Updated `TREND_SCALP` to use a faster path-specific exit:
  - new input `Exit On Close Below EMA9`, default `ON`
  - `TREND_SCALP` now exits on a close below `EMA9` instead of waiting for the shared `MACD_BEAR` exit
  - shared `HARD STOP`, stochastic exit, and optional time stop remain in place
  - purpose: manage grinder/scalp entries more like quick trend holds and less like slower burst trades
- Added a first minimal `BURST_SCALP` path for `AGAE`-style violent small-cap moves while preserving the original `SPIKE_ACCEL` logic:
  - new path `BURST_SCALP`, default `ON`
  - simpler hard rules only:
    - strong green expansion bar
    - close near the high of the breakout bar
    - breakout above recent high
    - relative volume versus the 20-bar average
    - optional close above `EMA9`
  - kept `SPIKE_ACCEL` in place for comparison rather than deleting it
  - purpose: build a cleaner, easier-to-tune burst baseline without the full acceleration state stack
- Reset exits back to a shared model across all paths after the user noted that one-position-only comparisons should use the same exit criteria:
  - removed the path-specific `TREND_SCALP` `EMA9` close exit experiment
  - active paths now all use the same shared exits again:
    - `HARD STOP`
    - `MACD_BEAR`
    - `STOCHK EXIT`
    - optional `TIME STOP`
  - purpose: keep burst / trend / continuation comparisons fair while the strategy still allows only one open position at a time
- Replaced `MACD_BEAR` as the shared exit after simulating the reference stocks (`AGAE` for burst, `ASTI` for trend):
  - active shared exits are now:
    - `HARD STOP`
    - `STOCHK EXIT`
    - optional `TIME STOP`
  - `MACD_BEAR` was removed from active exit logic because it materially underperformed on the burst reference and did not justify staying as the common exit baseline
  - purpose: use one cleaner shared exit model across all active paths while the strategy still allows only one open position at a time
- Added a first minimal `PULLBACK_SCALP` path to start filling the fast dip-and-reclaim hole the user wants this scalp strategy to cover:
  - path is intentionally simple and trend-structure first:
    - recent prior momentum seen within a configurable lookback
    - `EMA9 > EMA21` and `EMA9` not falling
    - prior bar pulls back into `EMA9`
    - optional red pullback bar
    - current reclaim bar is green
    - reclaim bar closes back above `EMA9`
    - reclaim bar closes above the prior bar high
    - light relative-volume check versus the `5`-bar average
    - reclaim bar close quality inside its own range
  - purpose: build a small, testable baseline for `AGAE`-style pullback re-entries before adding more conditions
- Adjusted path priority after first-pass `AGAE` testing showed `PULLBACK_SCALP` was overriding too many clean burst bars:
  - `BURST_SCALP` now takes priority over `PULLBACK_SCALP` when both are true on the same bar
  - purpose: preserve the stronger burst classification on overlap bars while keeping pullback available for separate reclaim setups
- Tightened `PULLBACK_SCALP` after follow-up review suggested it should be a true dip/reclaim setup, not just another above-EMA overlap path:
  - added `Require Pullback Below EMA9`, default `ON`
  - added `Require Actual Pullback Bar`, default `ON`
  - pullback now requires:
    - prior momentum still visible
    - `EMA9 > EMA21` and `EMA9` not falling
    - prior bar touches `EMA9`
    - and by default dips below `EMA9`
    - optional red pullback bar
    - actual one-bar giveback structure (`close[1] < close[2]` and `high[1] <= high[2]`)
    - reclaim bar closes back above `EMA9`
    - reclaim bar closes above prior bar high
    - light relative-volume and reclaim close-quality checks
  - purpose: make pullback more distinct from trend/burst and closer to a real support reclaim entry
- Reworked the `PULLBACK_SCALP` momentum-context gate after reviewing `AGAE` near-misses showed the old seed-based momentum check was the dominant blocker:
  - removed dependency on recent burst/trend/impulse path signals for momentum context
  - replaced it with a simpler recent upmove measurement:
    - `Prior Upmove Lookback Bars`
    - `Prior Upmove Min %`
  - pullback now arms off actual recent price progress instead of requiring one of the other strategy paths to have fired first
  - purpose: keep pullback distinct, but let it recognize reclaim setups on their own instead of being chained to other entry seeds
- Reworked `PULLBACK_SCALP` again after the user clarified the real shape they want is a `2-3` bar dip/reclaim, not a one-bar pullback:
  - added `Pullback Bars`, default `2`
  - replaced one-bar pullback checks with a small pullback window / mini-base:
    - use the prior `Pullback Bars` as the pullback base
    - require that base to touch `EMA9`
    - optionally require it to dip below `EMA9`
    - require the pullback base to show giveback rather than just a fresh continuation burst
    - require the reclaim bar to close back above `EMA9`
    - require the reclaim bar to close above the high of the pullback base
  - purpose: make pullback match the actual small-cap day-trading shape the user highlighted: burst -> 2-3 bar dip/stall -> reclaim
- Rolled back the `2-3` bar pullback-window rewrite after fresh `AGAE` testing showed it reduced trade quality and total P&L:
  - removed the `Pullback Bars` mini-base version
  - restored the prior pullback baseline:
    - recent upmove context
    - prior bar touch/below `EMA9`
    - optional red pullback bar
    - optional actual one-bar giveback structure
    - reclaim bar closes back above `EMA9`
    - reclaim bar closes above prior bar high
  - light volume and reclaim close-quality checks
  - reason: the mini-base rewrite removed the best pullback winner and introduced a much worse late pullback loser on the `AGAE` reference day

## 2026-04-16

- Replaced the old split TradingView setup with a new canonical pair:
  - `tradingview/multi-path-momentum-scalp-v1.0-indicator.pine`
  - `tradingview/multi-path-momentum-scalp-v1.0-strategy.pine`
- Archived the previous active TradingView scripts so the repo now has one clear current pair instead of a mix of legacy momentum/scalp files:
  - `macd-momentum-alerts-v3.4.2_1.pine`
  - `macd-momentum-strategy-v3.4.4.pine`
  - `spike-scalp-early-accel-strategy-v1.5.pine`
- The new pair unifies the earlier momentum and scalp work into a single **five-path** model with strict priority order:
  - `P1_CROSS` = MACD cross above signal
  - `P2_VWAP` = VWAP breakout with MACD already bullish
  - `P3_SURGE` = MACD momentum surge / continuation path
  - `P4_BURST` = violent impulse bar / burst scalp
  - `P5_PULLBACK` = dip to EMA9 + resume + mini-breakout
- Important architecture change:
  - `P1/P2/P3` remain the more traditional momentum-style paths and still use the shared momentum gates
  - `P4/P5` are now embedded directly into the same system instead of living in a separate scalp script
  - this means burst and pullback are no longer treated as separate Pine products; they are now first-class paths inside the main multi-path model
- Confirmation logic was simplified versus earlier experiments:
  - default confirmation is now `1` bar
  - quality-score confirmation remains available
  - `P4_BURST` and `P5_PULLBACK` are designed to fire instantly and only if higher-priority paths did not already win that bar
- `P3_SURGE` keeps the more advanced continuation logic that had evolved over time:
  - normal EMA20 / StochK / EMA9 stretch / VWAP gates
  - controlled high-VWAP override
  - separate news-spike / momentum override
  - purpose: preserve good continuation coverage without reopening the separate `CONTINUATION` and `REACCEL` branches
- `P4_BURST` is now codified as a clean first-impulse path inside the main script:
  - abnormal body/range expansion
  - close near the high of the bar
  - recent-high breakout
  - relative volume vs 20-bar average
  - optional close above EMA9
- `P5_PULLBACK` is now codified directly in the main script instead of the older iterative pullback experiments:
  - looks back for a recent spike anchor
  - requires meaningful giveback from that spike
  - requires the resume bar to occur near EMA9
  - resume bar must stay smaller/tamer than a burst bar
  - requires breakout of recent bars plus light relative-volume and close-quality checks
  - also requires price to remain reasonably close to session high to avoid deep falling-knife reclaims
- Exits in the new TradingView pair are fully integrated in-script again:
  - partials at `2%`, `FAST4`, and `4% after 2%`
  - tiered StochK exits
  - MACD bear exit
  - profit-floor system with locked tiers and trailing above 4%
  - strategy version mirrors this with strategy partial closes and tagged final exits
- The indicator version sends live webhook alerts for:
  - `BUY`
  - scale milestones
  - final `CLOSE` reasons
  - `HEARTBEAT`
  - and includes full floor/tier/profit context in the heartbeat payload for server-side awareness
- The strategy version is explicitly the backtest/export twin:
  - same entry logic
  - same partial/exit logic
  - no live heartbeat behavior
  - intended for TradingView strategy tester / CSV export only
- Visual/debugging quality improved materially in the new pair:
  - dedicated path labels for all five entries
  - confirm markers
  - profit-aware exit labels
  - partial-scale labels
  - dashboard showing regime, score, path state, floor, tier, and gate status
- New practical defaults in this pair are broader than the earlier momentum-only setup:
  - volume threshold reduced to `5000`
  - cooldown default `0`
  - trading hours widened to `07:00-18:00`
  - dead zone disabled by default
  - intention: give the unified script more room to act across both premarket momentum bursts and regular-hours continuation/reclaim setups
- Net conclusion:
  - this new pair supersedes the previous separate momentum-vs-scalp Pine split
  - the repo should treat `multi-path-momentum-scalp-v1.0-*` as the preserved active TradingView baseline until a later named version replaces it
- Synced the repo indicator file with the newer TradingView copy from `Downloads` after confirming the workspace version was missing the active `SCALE` webhook alerts.
- Restored indicator-side `SCALE` alert payloads for `FAST4`, `PCT2`, and `PCT4_AFTER2` so the repo copy matches the live Pine workflow again.
- Updated stale repo references to point at the unified Pine pair:
  - `README.md`
  - `tradingview/README.md`
  - `test/pine-contract.test.js`
- Removed dead server implementations from `src/services/schwab.js`:
  - legacy `placeBuyOrder()` TRIGGER + child-stop path
  - legacy `checkFloors()` monitor
- Updated `README.md` env-var docs to reflect the active hard-stop configuration and remove the stale `STOP_LOSS_CENTS` reference.

## Ongoing Rule For Future Sessions

- Record meaningful analysis, file updates, and architecture decisions here whenever changes are made.
- Keep TradingView payload structure and backend expectations synchronized and note those changes here.

## Current State Snapshot (2026-04-15 20:04:55 -04:00)

### Strategy Role

- This scalp strategy is **not** intended to replace the live Railway `MACD momentum` system.
- Current design goal:
  - fill the holes the momentum system misses
  - catch earlier burst entries
  - catch staircase trend re-entries
  - eventually catch true pullback/reclaim entries

### Reference Symbols

- `AGAE` = preserved burst / low-float / jumpy reference stock
- `ASTI` = preserved trend / staircase grinder reference stock

### Position / Exit Model

- One position at a time only
- `pyramiding = 0`
- Shared exits across active paths:
  - `HARD STOP`
  - `STOCHK EXIT`
  - optional `TIME STOP`
- `MACD_BEAR` is no longer part of active shared exit logic

### Active Paths

#### `SPIKE_ACCEL`

- Preserved original early-acceleration burst path
- Still present in code for reference/comparison
- Often masked in practice by `BURST_SCALP` when both qualify on the same bar

#### `BURST_SCALP`

- Active and currently the strongest path on `AGAE`
- Current simple baseline:
  - green expansion bar
  - body % or range % large enough
  - close near high
  - breakout above recent high
  - relative volume vs `20`-bar average
  - optional close above `EMA9`
- Current role:
  - primary burst / first-punch hole-filler

#### `TREND_SCALP`

- Active and preserved baseline on `ASTI`
- Current working baseline:
  - `EMA9 > EMA21`
  - `EMA21` rising over lookback
  - close above `EMA9`
  - light volume check
  - `3`-bar shelf
  - shelf tightness `% = 0.60`
  - breakout close above shelf high
  - breakout close ratio `0.60`
  - `VWAP` used lightly, not as a strong blocker
- Current role:
  - grinder / staircase trend hole-filler

#### `CONTINUATION`

- Still enabled in code
- Not current main focus
- Considered secondary/experimental
- Concept:
  - post-spike pause/base -> second push

#### `REACCEL`

- Deprioritized and effectively off
- `Enable Reaccel Path = false`
- Kept in file for future reference only

#### `PULLBACK_SCALP`

- Active but unresolved
- Current restored baseline:
  - recent upmove context
  - `EMA9 > EMA21` and `EMA9` not falling
  - prior bar touches / dips below `EMA9`
  - optional red pullback bar
  - optional actual one-bar giveback structure
  - reclaim bar green
  - reclaim bar closes back above `EMA9`
  - reclaim bar closes above prior bar high
  - light `5`-bar volume check
  - reclaim close-quality filter
- Current role:
  - intended pullback / reclaim hole-filler on bursty small-cap names

## Preserved Baselines

### Burst Baseline

- Use `AGAE`
- Preserve:
  - `BURST_SCALP`
  - shared exits (`HARD STOP` + `STOCHK EXIT`)
- Do not casually retune unless explicitly testing burst changes

### Trend Baseline

- Use `ASTI`
- Preserve:
  - `TREND_SCALP`
  - `Shelf Bars = 3`
  - `Shelf Tightness % = 0.60`
  - `Breakout Close Ratio = 0.60`
  - `EMA21 Slope Lookback = 5`
  - `Volume x 5-Bar Avg = 1.00`
  - `Require Above VWAP = OFF`
  - `Allow VWAP Cross Entry = ON`
  - `Min VWAP Distance % = 0.00`
  - `Cooldown Bars = 0`

## Current Active TradingView Baseline

### Canonical Pine Pair

- Indicator:
  - `tradingview/multi-path-momentum-scalp-v1.0-indicator.pine`
- Strategy:
  - `tradingview/multi-path-momentum-scalp-v1.0-strategy.pine`

### Current Active Path Model

- `P1_CROSS`
- `P2_VWAP`
- `P3_SURGE`
- `P4_BURST`
- `P5_PULLBACK`

### Current Repo Convention

- The active TradingView system is now this paired indicator/strategy set.
- Older momentum-only and separate scalp Pine files are historical and live in `tradingview/archive/`.
- Future Pine iterations should version forward from this unified pair instead of reviving the archived split models unless there is a deliberate rollback decision.

## Pending Work

### 1. `PULLBACK_SCALP` is the main unresolved path

- Status:
  - structurally alive
  - no longer masking burst
  - but still low-quality on `AGAE`
- What we learned:
  - loose versions overlapped too much with burst
  - strict versions disappeared or introduced worse late losers
  - the `2-3` bar pullback-window rewrite was rejected and rolled back
- Current belief:
  - the remaining issue is the pullback definition itself, especially:
    - `Require Red Pullback Bar`
    - `Require Actual Pullback Bar`
    - how to distinguish a real pullback from a one-bar continuation/chop

### 2. Need outside review / second-opinion on pullback

- A full write-up was prepared for another agent
- Best external question now:
  - how should `PULLBACK_SCALP` be defined on `30s` small-cap names so it is:
    - distinct from `BURST_SCALP`
    - distinct from `TREND_SCALP`
    - but still catches real reclaim setups

### 3. Chart-data / trade-export mismatch still exists

- Important warning:
  - TradingView chart CSV signal columns do not always line up perfectly with trade export labels/results
- Use chart CSV directionally
- Trust trade export more for:
  - actual entries
  - actual path classification
  - actual P&L

## Future Enhancements

### Near-Term

- Improve `PULLBACK_SCALP` only
- Keep `BURST_SCALP` baseline preserved
- Keep `TREND_SCALP` baseline preserved
- Avoid reopening `REACCEL` or over-tuning `CONTINUATION` unless explicitly requested

### Possible Future Improvements

- Add better pullback-specific debug markers
  - show bars blocked only by one pullback rule
- Consider path-specific exits later
  - but only after entry logic is stable
- Consider simplifying / archiving old experimental paths if file becomes too confusing
  - especially `REACCEL`
  - maybe later `CONTINUATION` if it remains non-essential

### What Not To Do Right Now

- Do not redesign burst again
- Do not retune trend baseline casually
- Do not bring back shared `MACD_BEAR` exit
- Do not judge the scalp strategy by whether it beats the Railway momentum system total P&L
  - its role is complementary hole-filling, not replacement
