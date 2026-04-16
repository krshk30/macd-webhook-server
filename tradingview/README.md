# TradingView Workspace

This folder is the canonical place for TradingView Pine assets related to this server.

## Intended Contents

- The main Pine indicator or strategy script
- Alert message templates
- Notes about payload changes that must stay synchronized with the webhook server

## Current Status

- Current live indicator script in repo: `tradingview/multi-path-momentum-scalp-v1.0-indicator.pine`
- Current paired strategy script in repo: `tradingview/multi-path-momentum-scalp-v1.0-strategy.pine`
- Historical momentum-only and experimental scalp variants live under `tradingview/archive/`

## Workflow

1. Update the live indicator script in this folder.
2. Update the paired strategy script in the same pass so logic stays aligned.
3. Keep alert payload changes aligned with `src/routes/webhook.js`.
4. When the Pine scripts change, update `docs/SESSION_LOG.md` with the reason and what payload fields changed.
5. Keep experimental standalone strategies separate so their exports are easy to compare without contaminating the main system.

## Important

The Pine scripts in this folder are the GitHub source of truth. TradingView itself still needs manual copy/paste updates after repo changes.
