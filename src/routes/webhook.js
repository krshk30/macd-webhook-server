/**
 * Webhook Route v1.2.8
 * - HEARTBEAT: Pine sends heartbeat every bar close while in position
 *   Server tracks lastSignalTime. If no signal for 90s → BUY repainted → auto-close
 * - No brackets, LIMIT buffer, zero-qty guard
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { notify } = require('../services/notifications');
const { log } = require('../services/logger');
const router = express.Router();
const DEFAULT_QTY = () => parseInt(process.env.DEFAULT_QUANTITY || '10');

router.post('/webhook', async (req, res) => {
    const t0 = Date.now(), body = req.body;
    if (body.token !== process.env.WEBHOOK_TOKEN) { log('WARN', `Unauthorized ${req.ip}`); return res.status(401).json({ error: 'unauthorized' }); }
    if (!schwabService.isAuthenticated()) { log('ERROR', 'Not authenticated'); return res.status(503).json({ error: 'not_authenticated' }); }
    const { action, ticker, price } = body;
    if (!action || !ticker) return res.status(400).json({ error: 'missing action or ticker' });

    // HEARTBEAT is lightweight — no dedup, no full logging
    if (action === 'HEARTBEAT') {
        const pos = positions.getPosition(ticker);
        if (pos) {
            positions.touchPosition(ticker);
            return res.json({ status: 'heartbeat_ok', ticker, remaining: pos.remainingQuantity, serverLatency: Date.now() - t0 });
        }
        return res.json({ status: 'heartbeat_no_position', ticker });
    }

    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'} | Processing...`);
    if (positions.isDuplicate(ticker, action)) return res.json({ status: 'duplicate_filtered', latency: Date.now() - t0 });
    let result;
    try {
        switch (action) {
            case 'BUY':   result = await handleBuy(ticker, price, body); break;
            case 'SCALE': result = await handleScale(ticker, price, body); break;
            case 'CLOSE': result = await handleClose(ticker, price, body); break;
            default: return res.status(400).json({ error: `unknown: ${action}` });
        }
    } catch (err) { log('ERROR', `Webhook: ${err.message}`); result = { success: false, error: err.message }; }
    log('WEBHOOK', `Completed: ${action} ${ticker} | ${Date.now() - t0}ms`);
    res.json({ ...result, serverLatency: Date.now() - t0 });
});

async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) { log('REJECT', `BUY ${ticker}: ${check.reason}`); return { success: false, rejected: check.reason }; }
    const qty = DEFAULT_QTY(), entryPrice = parseFloat(price) || 0;
    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);
    if (result.success) positions.openPosition(ticker, entryPrice, qty);
    return { success: result.success, action: 'BUY', ticker, quantity: qty, entryPrice, orderId: result.orderId, schwabLatency: result.latency, session: schwabService.getSessionType(), path: body.path || 'unknown' };
}

async function handleScale(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `SCALE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }
    const level = body.level, sellPct = parseInt(body.sell_pct) || 50, currentPrice = parseFloat(price) || 0;
    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);
    if (!scaleResult || scaleResult.sharesToSell <= 0) { log('WARN', `SCALE ${ticker}: nothing to sell`); return { success: false, rejected: 'nothing to sell' }; }
    const result = await schwabService.placeSellOrder(ticker, scaleResult.sharesToSell, `Scale ${level} (${sellPct}%)`, currentPrice);
    return { success: result.success, action: 'SCALE', ticker, level, sharesSold: scaleResult.sharesToSell, remaining: pos.remainingQuantity, scalePnL: scaleResult.pnl.toFixed(2), schwabLatency: result.latency };
}

async function handleClose(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `CLOSE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }
    const exitPrice = parseFloat(price) || 0, reason = body.reason || 'unknown';
    if (pos.remainingQuantity <= 0) { log('INFO', `CLOSE ${ticker}: fully scaled out`); const s = positions.closePosition(ticker, exitPrice, 'all_scaled_out'); return { success: true, action: 'CLOSE', ticker, reason: 'all_scaled_out', sharesClosed: 0, pnl: s ? s.pnl.toFixed(2) : '0.00' }; }
    await schwabService.cancelOrdersForTicker(ticker);
    const result = await schwabService.placeSellOrder(ticker, pos.remainingQuantity, `Close: ${reason}`, exitPrice);
    const summary = positions.closePosition(ticker, exitPrice, reason);
    await notify(`CLOSED ${ticker}\nEntry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\nP&L: $${summary.pnl.toFixed(2)} | ${reason}`, summary.pnl >= 0 ? 'profit' : 'loss');
    return { success: result.success, action: 'CLOSE', ticker, reason, sharesClosed: summary.remainingClosed, pnl: summary.pnl.toFixed(2), schwabLatency: result.latency };
}

module.exports = { webhookRouter: router };
