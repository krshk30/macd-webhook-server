/**
 * Webhook Route v1.3.0
 * 
 * Changes:
 *   - Passes full webhook body to openPosition for journal logging
 *   - Trade ID included in all responses
 *   - Better error context in logs
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { notify } = require('../services/notifications');
const { log, getTradeId } = require('../services/logger');
const router = express.Router();
const DEFAULT_QTY = () => parseInt(process.env.DEFAULT_QUANTITY || '10');

router.post('/webhook', async (req, res) => {
    const t0 = Date.now(), body = req.body;

    if (body.token !== process.env.WEBHOOK_TOKEN) {
        log('WARN', `Unauthorized webhook attempt`, { ip: req.ip });
        return res.status(401).json({ error: 'unauthorized' });
    }
    if (!schwabService.isAuthenticated()) {
        log('ERROR', 'Webhook received but not authenticated');
        return res.status(503).json({ error: 'not_authenticated' });
    }

    const { action, ticker, price } = body;
    if (!action || !ticker) return res.status(400).json({ error: 'missing action or ticker' });

    // --- HEARTBEAT ---
    if (action === 'HEARTBEAT') {
        const pos = positions.getPosition(ticker);
        if (pos) {
            positions.touchPosition(ticker);
            // v1.3.0: Stop ratcheting handled by floor monitor (5s interval)
            // Heartbeat only proves Pine is still tracking this position
            return res.json({
                status: 'heartbeat_ok',
                ticker,
                tradeId: pos.tradeId,
                remaining: pos.remainingQuantity,
                currentStop: positions.getStopPrice(ticker),
                tier: body.tier,
                profitPct: body.profitPct,
                serverLatency: Date.now() - t0
            });
        }
        return res.json({ status: 'heartbeat_no_position', ticker });
    }

    const tradeId = getTradeId(ticker);
    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'}`, {
        tradeId, path: body.path, score: body.score, stochK: body.stochK
    });

    if (positions.isDuplicate(ticker, action)) {
        return res.json({ status: 'duplicate_filtered', tradeId, latency: Date.now() - t0 });
    }

    let result;
    try {
        switch (action) {
            case 'BUY':   result = await handleBuy(ticker, price, body); break;
            case 'SCALE': result = await handleScale(ticker, price, body); break;
            case 'CLOSE': result = await handleClose(ticker, price, body); break;
            default: return res.status(400).json({ error: `unknown: ${action}` });
        }
    } catch (err) {
        log('ERROR', `Webhook error: ${action} ${ticker}`, { error: err.message, tradeId });
        result = { success: false, error: err.message };
    }

    log('WEBHOOK', `Completed: ${action} ${ticker} | ${Date.now() - t0}ms`, { tradeId });
    res.json({ ...result, serverLatency: Date.now() - t0 });
});

async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) {
        log('REJECT', `BUY ${ticker}: ${check.reason}`, {
            stochK: body.stochK, macd: body.macd, score: body.score
        });
        return { success: false, rejected: check.reason };
    }

    const qty = DEFAULT_QTY();
    const entryPrice = parseFloat(price) || 0;

    // v1.3.0: Single TRIGGER order — BUY fills → child STOP activates
    // No delay, no separate stop call, no race condition
    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);

    if (result.success) {
        positions.openPosition(ticker, entryPrice, qty, body);
        // Record the stop price from the TRIGGER order
        if (result.stopPrice) {
            positions.setStopOrder(ticker, null, result.stopPrice);
        }
    }

    const tradeId = getTradeId(ticker);
    return {
        success: result.success,
        action: 'BUY',
        tradeId,
        ticker,
        quantity: qty,
        signalPrice: entryPrice,
        stopPrice: result.stopPrice || 0,
        orderId: result.orderId,
        schwabLatency: result.latency,
        session: schwabService.getSessionType(),
        path: body.path || 'unknown',
        score: body.score || null
    };
}

async function handleScale(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) {
        log('REJECT', `SCALE ${ticker}: no position`);
        return { success: false, rejected: 'no position' };
    }

    const level = body.level;
    const sellPct = parseInt(body.sell_pct) || 50;
    const currentPrice = parseFloat(price) || 0;

    // Cancel existing stop BEFORE placing new TRIGGER order
    const oldStopId = positions.getStopOrderId(ticker);
    if (oldStopId) {
        await schwabService.cancelOrder(oldStopId);
    }
    // Also cancel any other lingering orders
    await schwabService.cancelOrdersForTicker(ticker);

    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);

    if (!scaleResult || scaleResult.sharesToSell <= 0) {
        log('WARN', `SCALE ${ticker}: nothing to sell`, {
            tradeId: pos.tradeId, level, sellPct, remaining: pos.remainingQuantity
        });
        // Re-place stop since we cancelled it
        const currentStop = positions.getStopPrice(ticker);
        if (currentStop > 0 && pos.remainingQuantity > 0) {
            const stopResult = await schwabService.placeStopOrder(ticker, pos.remainingQuantity, currentStop);
            if (stopResult.success) positions.updateStopPrice(ticker, currentStop, stopResult.orderId);
        }
        return { success: false, rejected: 'nothing to sell' };
    }

    const updatedPos = positions.getPosition(ticker);
    const remaining = updatedPos ? updatedPos.remainingQuantity : 0;
    const currentStop = positions.getStopPrice(ticker) || (pos.entryPrice - parseFloat(process.env.STOP_LOSS_CENTS || '0.02'));
    let result;

    if (remaining > 0) {
        // v1.3.0: SELL+STOP TRIGGER — sell scale shares, child STOP for remaining
        result = await schwabService.placeSellWithStop(
            ticker, scaleResult.sharesToSell, remaining,
            `Scale ${level} (${sellPct}%)`, currentPrice, currentStop
        );
        if (result.success) {
            positions.updateStopPrice(ticker, currentStop, null);
        }
    } else {
        // Selling everything — no child stop needed
        result = await schwabService.placeSellOrder(
            ticker, scaleResult.sharesToSell,
            `Scale ${level} (${sellPct}%)`, currentPrice
        );
    }

    return {
        success: result.success,
        action: 'SCALE',
        tradeId: pos.tradeId,
        ticker, level,
        sharesSold: scaleResult.sharesToSell,
        remaining,
        scalePnL: scaleResult.pnl.toFixed(2),
        currentStop,
        schwabLatency: result.latency
    };
}

async function handleClose(ticker, price, body) {
    const pos = positions.getPosition(ticker);
    if (!pos) {
        log('REJECT', `CLOSE ${ticker}: no position`);
        return { success: false, rejected: 'no position' };
    }

    const exitPrice = parseFloat(price) || 0;
    const reason = body.reason || 'unknown';

    if (pos.remainingQuantity <= 0) {
        log('INFO', `CLOSE ${ticker}: fully scaled out`, { tradeId: pos.tradeId });
        const s = positions.closePosition(ticker, exitPrice, 'all_scaled_out');
        return {
            success: true, action: 'CLOSE', tradeId: pos.tradeId,
            ticker, reason: 'all_scaled_out', sharesClosed: 0,
            pnl: s ? s.pnl.toFixed(2) : '0.00',
            totalPnL: s ? s.totalPnL.toFixed(2) : '0.00'
        };
    }

    // v1.3.0: Mark position as closing so heartbeat doesn't place new stops
    pos.isClosing = true;

    // v1.3.0: Cancel the tracked stop order by ID first (fastest)
    const stopId = positions.getStopOrderId(ticker);
    if (stopId) {
        await schwabService.cancelOrder(stopId);
        log('STOP', `Cancelled stop ${stopId} before CLOSE`, { ticker });
    }

    // Also cancel any other open orders for this ticker
    await schwabService.cancelOrdersForTicker(ticker);

    // Wait for cancellations to settle on Schwab's side
    await new Promise(r => setTimeout(r, 500));

    const result = await schwabService.placeSellOrder(
        ticker, pos.remainingQuantity,
        `Close: ${reason}`, exitPrice
    );

    const summary = positions.closePosition(ticker, exitPrice, reason);

    await notify(
        `CLOSED ${ticker}\n` +
        `TradeID: ${summary.tradeId}\n` +
        `Entry: $${summary.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: $${summary.pnl.toFixed(2)} (total: $${summary.totalPnL.toFixed(2)})\n` +
        `Hold: ${summary.holdMinutes}m | ${reason}`,
        summary.totalPnL >= 0 ? 'profit' : 'loss'
    );

    return {
        success: result.success,
        action: 'CLOSE',
        tradeId: summary.tradeId,
        ticker, reason,
        sharesClosed: summary.remainingClosed,
        pnl: summary.pnl.toFixed(2),
        totalPnL: summary.totalPnL.toFixed(2),
        holdMinutes: summary.holdMinutes,
        schwabLatency: result.latency
    };
}

module.exports = { webhookRouter: router };
