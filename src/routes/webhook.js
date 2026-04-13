/**
 * Webhook Route v1.4.0
 *
 * Changes:
 *   - Plain BUY entries with pending-fill tracking for limit orders
 *   - Server-managed scale protection; no child stop orchestration in the route
 *   - Pending entries can be cancelled cleanly on CLOSE before fill
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { notify } = require('../services/notifications');
const { log, getTradeId } = require('../services/logger');

const router = express.Router();
const DEFAULT_QTY = () => parseInt(process.env.DEFAULT_QUANTITY || '10');

router.post('/webhook', async (req, res) => {
    const t0 = Date.now();
    const body = req.body;

    if (!body || typeof body !== 'object') {
        log('WARN', 'Webhook received with empty/invalid body', {
            ip: req.ip,
            contentType: req.headers['content-type'],
            rawBodyType: typeof body
        });
        return res.status(400).json({ error: 'invalid body' });
    }

    if (body.token !== process.env.WEBHOOK_TOKEN) {
        log('WARN', 'Unauthorized webhook attempt', {
            ip: req.ip,
            action: body.action,
            ticker: body.ticker,
            receivedToken: body.token ? body.token.substring(0, 5) + '***' : 'MISSING',
            expectedToken: process.env.WEBHOOK_TOKEN ? process.env.WEBHOOK_TOKEN.substring(0, 5) + '***' : 'NOT_SET',
            bodyKeys: Object.keys(body || {}).join(','),
            contentType: req.headers['content-type']
        });
        return res.status(401).json({ error: 'unauthorized' });
    }

    if (!schwabService.isAuthenticated()) {
        log('ERROR', 'Webhook received but not authenticated');
        return res.status(503).json({ error: 'not_authenticated' });
    }

    const { action, ticker, price } = body;
    if (!action || !ticker) return res.status(400).json({ error: 'missing action or ticker' });

    if (action === 'HEARTBEAT') {
        const pos = positions.getPosition(ticker);
        if (pos) {
            positions.touchPosition(ticker);
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

        if (positions.hasPendingEntry(ticker)) {
            positions.touchPosition(ticker);
            return res.json({ status: 'heartbeat_pending_entry', ticker });
        }

        return res.json({ status: 'heartbeat_no_position', ticker });
    }

    const tradeId = getTradeId(ticker);
    log('WEBHOOK', `Received: ${action} ${ticker} @ $${price || '?'}`, {
        tradeId,
        path: body.path,
        score: body.score,
        stochK: body.stochK
    });

    if (positions.isDuplicate(ticker, action)) {
        return res.json({ status: 'duplicate_filtered', tradeId, latency: Date.now() - t0 });
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
                return res.status(400).json({ error: `unknown: ${action}` });
        }
    } catch (err) {
        log('ERROR', `Webhook error: ${action} ${ticker}`, {
            error: err.message,
            tradeId
        });
        result = { success: false, error: err.message };
    }

    log('WEBHOOK', `Completed: ${action} ${ticker} | ${Date.now() - t0}ms`, { tradeId: getTradeId(ticker) || tradeId });
    return res.json({ ...result, serverLatency: Date.now() - t0 });
});

async function handleBuy(ticker, price, body) {
    const check = positions.canOpenPosition(ticker);
    if (!check.allowed) {
        log('REJECT', `BUY ${ticker}: ${check.reason}`, {
            stochK: body.stochK,
            macd: body.macd,
            score: body.score
        });
        return { success: false, rejected: check.reason };
    }

    const qty = DEFAULT_QTY();
    const entryPrice = parseFloat(price) || 0;
    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);

    if (result.success) {
        if (result.needsFillConfirmation) {
            positions.createPendingEntry(ticker, entryPrice, qty, result.orderId, body, {
                session: result.session,
                orderType: result.orderType
            });
        } else {
            positions.openPosition(ticker, entryPrice, qty, body);
        }
    }

    const tradeId = getTradeId(ticker);
    return {
        success: result.success,
        pending: !!result.needsFillConfirmation,
        action: 'BUY',
        tradeId,
        ticker,
        quantity: qty,
        signalPrice: entryPrice,
        orderId: result.orderId,
        schwabLatency: result.latency,
        session: result.session || schwabService.getSessionType(),
        path: body.path || 'unknown',
        score: body.score || null
    };
}

async function handleScale(ticker, price, body) {
    await schwabService.syncPendingEntries(positions, ticker);
    const pos = positions.getPosition(ticker);

    if (!pos) {
        if (positions.hasPendingEntry(ticker)) {
            log('REJECT', `SCALE ${ticker}: pending entry not filled yet`);
            return { success: false, rejected: 'pending entry not filled' };
        }
        log('REJECT', `SCALE ${ticker}: no position`);
        return { success: false, rejected: 'no position' };
    }

    const level = body.level;
    const sellPct = parseInt(body.sell_pct) || 50;
    const currentPrice = parseFloat(price) || 0;

    if (positions.isMilestoneHit(ticker, level)) {
        log('DEDUP', `Ignoring already-hit scale ${ticker}:${level}`, { tradeId: pos.tradeId });
        return {
            success: true,
            action: 'SCALE',
            ignored: 'milestone_already_hit',
            tradeId: pos.tradeId,
            ticker,
            level
        };
    }

    const preview = positions.previewScalePosition(ticker, sellPct, currentPrice);
    if (!preview || preview.sharesToSell <= 0) {
        log('WARN', `SCALE ${ticker}: nothing to sell`, {
            tradeId: pos.tradeId,
            level,
            sellPct,
            remaining: pos.remainingQuantity
        });
        return { success: false, rejected: 'nothing to sell' };
    }

    const result = await schwabService.placeSellOrder(
        ticker,
        preview.sharesToSell,
        `Scale ${level} (${sellPct}%)`,
        currentPrice
    );

    if (!result.success) {
        return {
            success: false,
            action: 'SCALE',
            tradeId: pos.tradeId,
            ticker,
            level,
            rejected: result.error || 'sell failed',
            schwabLatency: result.latency
        };
    }

    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);
    const updatedPos = positions.getPosition(ticker);

    return {
        success: true,
        action: 'SCALE',
        tradeId: pos.tradeId,
        ticker,
        level,
        sharesSold: scaleResult.sharesToSell,
        remaining: updatedPos ? updatedPos.remainingQuantity : 0,
        scalePnL: scaleResult.pnl.toFixed(2),
        currentStop: positions.getStopPrice(ticker) || 0,
        schwabLatency: result.latency
    };
}

async function handleClose(ticker, price, body) {
    await schwabService.syncPendingEntries(positions, ticker);
    const pos = positions.getPosition(ticker);

    if (!pos) {
        const pending = positions.getPendingEntry(ticker);
        if (pending) {
            await schwabService.cancelOrder(pending.orderId);
            await schwabService.cancelOrdersForTicker(ticker);
            positions.clearPendingEntry(ticker, 'close_before_fill');
            return {
                success: true,
                action: 'CLOSE',
                ticker,
                reason: body.reason || 'close_before_fill',
                cancelledPending: true
            };
        }

        log('REJECT', `CLOSE ${ticker}: no position`);
        return { success: false, rejected: 'no position' };
    }

    const exitPrice = parseFloat(price) || 0;
    const reason = body.reason || 'unknown';

    if (pos.remainingQuantity <= 0) {
        log('INFO', `CLOSE ${ticker}: fully scaled out`, { tradeId: pos.tradeId });
        const summary = positions.closePosition(ticker, exitPrice, 'all_scaled_out');
        return {
            success: true,
            action: 'CLOSE',
            tradeId: pos.tradeId,
            ticker,
            reason: 'all_scaled_out',
            sharesClosed: 0,
            pnl: summary ? summary.pnl.toFixed(2) : '0.00',
            totalPnL: summary ? summary.totalPnL.toFixed(2) : '0.00'
        };
    }

    pos.isClosing = true;
    await schwabService.cancelOrdersForTicker(ticker);
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await schwabService.placeSellOrder(
        ticker,
        pos.remainingQuantity,
        `Close: ${reason}`,
        exitPrice
    );

    if (!result.success) {
        pos.isClosing = false;
        return {
            success: false,
            action: 'CLOSE',
            tradeId: pos.tradeId,
            ticker,
            reason,
            rejected: result.error || 'sell failed',
            schwabLatency: result.latency
        };
    }

    const summary = positions.closePosition(ticker, exitPrice, reason);

    await notify(
        `CLOSED ${ticker}\n` +
        `TradeID: ${summary.tradeId}\n` +
        `Entry: $${summary.entryPrice.toFixed(2)} -> Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: $${summary.pnl.toFixed(2)} (total: $${summary.totalPnL.toFixed(2)})\n` +
        `Hold: ${summary.holdMinutes}m | ${reason}`,
        summary.totalPnL >= 0 ? 'profit' : 'loss'
    );

    return {
        success: true,
        action: 'CLOSE',
        tradeId: summary.tradeId,
        ticker,
        reason,
        sharesClosed: summary.remainingClosed,
        pnl: summary.pnl.toFixed(2),
        totalPnL: summary.totalPnL.toFixed(2),
        holdMinutes: summary.holdMinutes,
        schwabLatency: result.latency
    };
}

module.exports = { webhookRouter: router };
