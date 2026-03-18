/**
 * Webhook Route v1.2.6
 * - Verify actual Schwab position before ANY sell (anti-short protection)
 * - CANCEL_BUY handler for repaint detection
 * - No bracket orders (simple BUY only)
 * - handleClose zero-quantity guard
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
    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'} | Processing...`);
    if (positions.isDuplicate(ticker, action)) return res.json({ status: 'duplicate_filtered', latency: Date.now() - t0 });
    let result;
    try {
        switch (action) {
            case 'BUY':        result = await handleBuy(ticker, price, body); break;
            case 'SCALE':      result = await handleScale(ticker, price, body); break;
            case 'CLOSE':      result = await handleClose(ticker, price, body); break;
            case 'CANCEL_BUY': result = await handleCancelBuy(ticker, price, body); break;
            default: return res.status(400).json({ error: `unknown: ${action}` });
        }
    } catch (err) { log('ERROR', `Webhook: ${err.message}`); result = { success: false, error: err.message }; }
    log('WEBHOOK', `Completed: ${action} ${ticker} | ${Date.now() - t0}ms`);
    res.json({ ...result, serverLatency: Date.now() - t0 });
});

// ─── BUY (simple order, no bracket) ────────────────────────────
async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) { log('REJECT', `BUY ${ticker}: ${check.reason}`); return { success: false, rejected: check.reason }; }
    const qty = DEFAULT_QTY(), entryPrice = parseFloat(price) || 0;
    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);
    if (result.success) positions.openPosition(ticker, entryPrice, qty);
    return { success: result.success, action: 'BUY', ticker, quantity: qty, entryPrice, orderId: result.orderId, schwabLatency: result.latency, session: schwabService.getSessionType(), path: body.path || 'unknown' };
}

// ─── CANCEL_BUY (repaint detected) ────────────────────────────
async function handleCancelBuy(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('INFO', `CANCEL_BUY ${ticker}: no position`); return { success: true, action: 'CANCEL_BUY', reason: 'no_position' }; }
    const exitPrice = parseFloat(price) || pos.entryPrice;
    log('WARN', `⚠️ REPAINT DETECTED: ${ticker} — verifying Schwab position...`);

    // v1.2.6: Verify actual shares on Schwab before selling
    const actualQty = await schwabService.verifyPositionOnSchwab(ticker);
    if (actualQty <= 0) {
        log('WARN', `CANCEL_BUY ${ticker}: no shares on Schwab — cleaning tracker only`);
        positions.closePosition(ticker, exitPrice, 'REPAINT_NO_SHARES');
        return { success: true, action: 'CANCEL_BUY', ticker, reason: 'no_shares_on_schwab', sharesClosed: 0 };
    }

    const sellQty = Math.min(pos.remainingQuantity, actualQty);
    await schwabService.cancelOrdersForTicker(ticker);
    const result = await schwabService.placeSellOrder(ticker, sellQty, 'REPAINT_CANCEL', exitPrice);
    const summary = positions.closePosition(ticker, exitPrice, 'REPAINT_CANCEL');
    await notify(`⚠️ REPAINT CANCEL: ${ticker} x${sellQty}\nEntry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\nP&L: $${summary.pnl.toFixed(2)}`, 'error');
    return { success: result.success, action: 'CANCEL_BUY', ticker, sharesClosed: sellQty, pnl: summary.pnl.toFixed(2), schwabLatency: result.latency };
}

// ─── SCALE ─────────────────────────────────────────────────────
async function handleScale(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `SCALE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }
    const level = body.level, sellPct = parseInt(body.sell_pct) || 50, currentPrice = parseFloat(price) || 0;

    // v1.2.6: Verify actual shares on Schwab before selling
    const actualQty = await schwabService.verifyPositionOnSchwab(ticker);
    if (actualQty <= 0) {
        log('WARN', `SCALE ${ticker}: no shares on Schwab — cleaning tracker`);
        positions.closePosition(ticker, currentPrice, 'scale_no_shares');
        return { success: false, rejected: 'no_shares_on_schwab' };
    }

    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);
    if (!scaleResult || scaleResult.sharesToSell <= 0) { log('WARN', `SCALE ${ticker}: nothing to sell`); return { success: false, rejected: 'nothing to sell' }; }

    const sellQty = Math.min(scaleResult.sharesToSell, actualQty);
    const result = await schwabService.placeSellOrder(ticker, sellQty, `Scale ${level} (${sellPct}%)`, currentPrice);
    return { success: result.success, action: 'SCALE', ticker, level, sharesSold: sellQty, remaining: pos.remainingQuantity, scalePnL: scaleResult.pnl.toFixed(2), schwabLatency: result.latency };
}

// ─── CLOSE ─────────────────────────────────────────────────────
async function handleClose(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `CLOSE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }
    const exitPrice = parseFloat(price) || 0, reason = body.reason || 'unknown';

    // If fully scaled out, just clean up tracker
    if (pos.remainingQuantity <= 0) {
        log('INFO', `CLOSE ${ticker}: fully scaled out — cleaning tracker`);
        const summary = positions.closePosition(ticker, exitPrice, 'all_scaled_out');
        return { success: true, action: 'CLOSE', ticker, reason: 'all_scaled_out', sharesClosed: 0, pnl: summary ? summary.pnl.toFixed(2) : '0.00' };
    }

    // v1.2.6: Verify actual shares on Schwab before selling
    const actualQty = await schwabService.verifyPositionOnSchwab(ticker);
    if (actualQty <= 0) {
        log('WARN', `CLOSE ${ticker}: no shares on Schwab — cleaning tracker only`);
        const summary = positions.closePosition(ticker, exitPrice, 'no_shares_on_schwab');
        return { success: true, action: 'CLOSE', ticker, reason: 'no_shares_on_schwab', sharesClosed: 0, pnl: summary ? summary.pnl.toFixed(2) : '0.00' };
    }

    await schwabService.cancelOrdersForTicker(ticker);
    const sellQty = Math.min(pos.remainingQuantity, actualQty);
    const result = await schwabService.placeSellOrder(ticker, sellQty, `Close: ${reason}`, exitPrice);
    const summary = positions.closePosition(ticker, exitPrice, reason);
    await notify(`CLOSED ${ticker}\nEntry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\nP&L: $${summary.pnl.toFixed(2)} | ${reason}`, summary.pnl >= 0 ? 'profit' : 'loss');
    return { success: result.success, action: 'CLOSE', ticker, reason, sharesClosed: sellQty, pnl: summary.pnl.toFixed(2), schwabLatency: result.latency };
}

module.exports = { webhookRouter: router };
