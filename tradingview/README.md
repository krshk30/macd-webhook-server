# TradingView Workspace

This folder is the canonical place for TradingView Pine assets related to this server.

## Intended Contents

- The main Pine indicator or strategy script
- Alert message templates
- Notes about payload changes that must stay synchronized with the webhook server

## Current Status

- Current Pine script in repo: `tradingview/macd-momentum-alerts-v3.4.2_1.pine`

## Workflow

1. Update the Pine script file in this folder.
2. Keep alert payload changes aligned with `src/routes/webhook.js`.
3. When the Pine script changes, update `docs/SESSION_LOG.md` with the reason and what payload fields changed.

## Important

The Pine script is now versioned here and should be treated as the GitHub source of truth. TradingView itself still needs manual copy/paste updates after repo changes.
