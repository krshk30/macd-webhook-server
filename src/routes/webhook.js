/**
 * Webhook Route v1.2.4
 * v1.2.4: handleClose skips sell if remainingQuantity <= 0 (all scaled out)
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { notify } = require('../services/notifications');
const { log } = require('../services/logger');
const router = express.Router();

const DEFAULT_QTY = () => parseInt(process.env.DEFAULT_QUANTITY || '10');
const TP_CENTS = () => parseFloat(process.env.TP_CENTS || '0.08');
const SL_CENTS = () => parseFloat(process.env.SL_CENTS || '0.05');

router.post('/webhook', async (req, res) => {
    const receiveTime = Date.now();
    const body = req.body;
    if (body.token !== process.env.WEBHOOK_TOKEN) { log('WARN', `Unauthorized from ${req.ip}`); return res.status(401).json({ error: 'unauthorized' }); }
    if (!schwabService.isAuthenticated()) { log('ERROR', 'Not authenticated'); return res.status(503).json({ error: 'not_authenticated' }); }
    const { action, ticker, price } = body;
    if (!action || !ticker) return res.status(400).json({ error: 'missing action or ticker' });
    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'} | Processing...`);
    if (positions.isDuplicate(ticker, action)) return res.json({ status: 'duplicate_filtered', latency: Date.now() - receiveTime });

    let result;
    try {
        switch (action) {
            case 'BUY':   result = await handleBuy(ticker, price, body); break;
            case 'SCALE': result = await handleScale(ticker, price, body); break;
            case 'CLOSE': result = await handleClose(ticker, price, body); break;
            default: return res.status(400).json({ error: `unknown action: ${action}` });
        }
    } catch (err) { log('ERROR', `Webhook error: ${err.message}`); result = { success: false, error: err.message }; }

    const totalLatency = Date.now() - receiveTime;
    log('WEBHOOK', `Completed: ${action} ${ticker} | ${totalLatency}ms`);
    res.json({ ...result, serverLatency: totalLatency });
});

async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) { log('REJECT', `BUY ${ticker}: ${check.reason}`); return { success: false, rejected: check.reason }; }
    const qty = DEFAULT_QTY();
    const entryPrice = parseFloat(price) || 0;
    const tpPrice = entryPrice + TP_CENTS();
    const slPrice = entryPrice - SL_CENTS();
    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);
    if (result.success) positions.openPosition(ticker, entryPrice, qty);
    return { success: result.success, action: 'BUY', ticker, quantity: qty, entryPrice,
        tp: tpPrice.toFixed(2), sl: slPrice.toFixed(2), orderId: result.orderId,
        schwabLatency: result.latency, session: schwabService.getSessionType(), path: body.path || 'unknown' };
}

async function handleScale(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `SCALE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }
    const level = body.level;
    const sellPct = parseInt(body.sell_pct) || 50;
    const currentPrice = parseFloat(price) || 0;
    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);
    if (!scaleResult || scaleResult.sharesToSell <= 0) {
        log('WARN', `SCALE ${ticker}: nothing to sell (${sellPct}% of ${pos.initialQuantity})`);
        return { success: false, rejected: 'nothing to sell' };
    }
    const result = await schwabService.placeSellOrder(ticker, scaleResult.sharesToSell, `Scale ${level} (${sellPct}%)`, currentPrice);
    return { success: result.success, action: 'SCALE', ticker, level,
        sharesSold: scaleResult.sharesToSell, remaining: pos.remainingQuantity,
        scalePnL: scaleResult.pnl.toFixed(2), schwabLatency: result.latency };
}

async function handleClose(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) { log('REJECT', `CLOSE ${ticker}: no position`); return { success: false, rejected: 'no position' }; }

    const exitPrice = parseFloat(price) || 0;
    const reason = body.reason || 'unknown';

    // v1.2.4: If all shares already scaled out, just clean up tracker — don't send empty sell
    if (pos.remainingQuantity <= 0) {
        log('INFO', `CLOSE ${ticker}: already fully scaled out (0 remaining) — cleaning up tracker`);
        const summary = positions.closePosition(ticker, exitPrice, 'all_scaled_out');
        return { success: true, action: 'CLOSE', ticker, reason: 'all_scaled_out',
            sharesClosed: 0, pnl: summary ? summary.pnl.toFixed(2) : '0.00' };
    }

    await schwabService.cancelOrdersForTicker(ticker);
    const result = await schwabService.placeSellOrder(ticker, pos.remainingQuantity, `Close: ${reason}`, exitPrice);
    const summary = positions.closePosition(ticker, exitPrice, reason);

    await notify(
        `CLOSED ${ticker}\nEntry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\nP&L: $${summary.pnl.toFixed(2)} | ${reason}`,
        summary.pnl >= 0 ? 'profit' : 'loss'
    );

    return { success: result.success, action: 'CLOSE', ticker, reason,
        sharesClosed: summary.remainingClosed, pnl: summary.pnl.toFixed(2), schwabLatency: result.latency };
}

module.exports = { webhookRouter: router };
