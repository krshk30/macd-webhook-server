/**
 * Webhook Route — receives TradingView alerts v1.2.1
 * Passes price to all order functions for extended hours LIMIT orders
 */

const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { notify } = require('../services/notifications');
const { log } = require('../services/logger');

const router = express.Router();

const DEFAULT_QTY = () => parseInt(process.env.DEFAULT_QUANTITY || '1000');
const TP_CENTS = () => parseFloat(process.env.TP_CENTS || '0.08');
const SL_CENTS = () => parseFloat(process.env.SL_CENTS || '0.05');

router.post('/webhook', async (req, res) => {
    const receiveTime = Date.now();
    const body = req.body;

    if (body.token !== process.env.WEBHOOK_TOKEN) {
        log('WARN', `Unauthorized webhook attempt from ${req.ip}`);
        return res.status(401).json({ error: 'unauthorized' });
    }

    if (!schwabService.isAuthenticated()) {
        log('ERROR', 'Schwab not authenticated — order rejected');
        return res.status(503).json({ error: 'not_authenticated' });
    }

    const { action, ticker, price } = body;
    if (!action || !ticker) {
        return res.status(400).json({ error: 'missing action or ticker' });
    }

    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'} | Processing...`);

    if (positions.isDuplicate(ticker, action)) {
        return res.json({ status: 'duplicate_filtered', latency: Date.now() - receiveTime });
    }

    let result;

    try {
        switch (action) {
            case 'BUY':
                result = await handleBuy(ticker, price, body);
                break;
            case 'SCALE':
                result = await handleScale(ticker, price, body);
                break;
            case 'CLOSE':
                result = await handleClose(ticker, price, body);
                break;
            default:
                return res.status(400).json({ error: `unknown action: ${action}` });
        }
    } catch (err) {
        log('ERROR', `Webhook handler error: ${err.message}`);
        result = { success: false, error: err.message };
    }

    const totalLatency = Date.now() - receiveTime;
    log('WEBHOOK', `Completed: ${action} ${ticker} | Server latency: ${totalLatency}ms`);
    res.json({ ...result, serverLatency: totalLatency });
});

async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) {
        log('REJECT', `BUY ${ticker} rejected: ${check.reason}`);
        return { success: false, rejected: check.reason };
    }

    const qty = DEFAULT_QTY();
    const entryPrice = parseFloat(price) || 0;
    const tpPrice = entryPrice + TP_CENTS();
    const slPrice = entryPrice - SL_CENTS();

    let result;
    if (entryPrice > 0) {
        result = await schwabService.placeBracketOrder(ticker, qty, tpPrice, slPrice);
    } else {
        result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);
    }

    if (result.success) {
        positions.openPosition(ticker, entryPrice, qty);
    }

    return {
        success: result.success,
        action: 'BUY',
        ticker,
        quantity: qty,
        entryPrice,
        tp: tpPrice.toFixed(2),
        sl: slPrice.toFixed(2),
        orderId: result.orderId,
        schwabLatency: result.latency,
        session: schwabService.getSessionType(),
        path: body.path || 'unknown'
    };
}

async function handleScale(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) {
        log('REJECT', `SCALE ${ticker} rejected: no position`);
        return { success: false, rejected: 'no position' };
    }

    const level = body.level;
    const sellPct = parseInt(body.sell_pct) || 50;
    const currentPrice = parseFloat(price) || 0;

    positions.markMilestone(ticker, level);

    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);
    if (!scaleResult || scaleResult.sharesToSell <= 0) {
        return { success: false, rejected: 'nothing to sell' };
    }

    const result = await schwabService.placeSellOrder(
        ticker,
        scaleResult.sharesToSell,
        `Scale ${level} (${sellPct}%)`,
        currentPrice
    );

    return {
        success: result.success,
        action: 'SCALE',
        ticker, level,
        sharesSold: scaleResult.sharesToSell,
        remaining: pos.remainingQuantity,
        scalePnL: scaleResult.pnl.toFixed(2),
        schwabLatency: result.latency
    };
}

async function handleClose(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) {
        log('REJECT', `CLOSE ${ticker} rejected: no position`);
        return { success: false, rejected: 'no position' };
    }

    const exitPrice = parseFloat(price) || 0;
    const reason = body.reason || 'unknown';

    await schwabService.cancelOrdersForTicker(ticker);

    const result = await schwabService.placeSellOrder(
        ticker,
        pos.remainingQuantity,
        `Close: ${reason}`,
        exitPrice
    );

    const summary = positions.closePosition(ticker, exitPrice, reason);

    await notify(
        `CLOSED ${ticker}\n` +
        `Entry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: $${summary.pnl.toFixed(2)} | ${reason}`,
        summary.pnl >= 0 ? 'profit' : 'loss'
    );

    return {
        success: result.success,
        action: 'CLOSE',
        ticker, reason,
        sharesClosed: summary.remainingClosed,
        pnl: summary.pnl.toFixed(2),
        schwabLatency: result.latency
    };
}

module.exports = { webhookRouter: router };
