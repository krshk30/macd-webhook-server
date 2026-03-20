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

            // v1.3.0: Skip stop ratcheting if position is being closed
            if (pos.isClosing) {
                return res.json({
                    status: 'heartbeat_ok_closing',
                    ticker,
                    tradeId: pos.tradeId,
                    serverLatency: Date.now() - t0
                });
            }

            // v1.3.0: Ratchet stop loss based on floor from Pine
            const floorPrice = parseFloat(body.floorPrice) || 0;
            const currentStop = positions.getStopPrice(ticker);
            let stopUpdated = false;

            // Fallback: if no stop exists yet (initial failed), place one now
            if (currentStop === 0) {
                const stopCents = parseFloat(process.env.STOP_LOSS_CENTS || '0.02');
                const fallbackStop = floorPrice > 0 ? floorPrice : pos.entryPrice - stopCents;
                if (fallbackStop > 0) {
                    const stopResult = await schwabService.placeStopOrder(
                        ticker, pos.remainingQuantity, fallbackStop
                    );
                    if (stopResult.success) {
                        positions.updateStopPrice(ticker, fallbackStop, stopResult.orderId);
                        stopUpdated = true;
                        log('STOP', `Fallback stop placed for ${ticker} @ $${fallbackStop.toFixed(2)}`);
                    }
                }
            } else if (floorPrice > 0 && floorPrice > currentStop) {
                // Floor has increased — cancel old stop, place new one
                const oldStopId = positions.getStopOrderId(ticker);
                if (oldStopId) {
                    await schwabService.cancelOrder(oldStopId);
                }
                const stopResult = await schwabService.placeStopOrder(
                    ticker, pos.remainingQuantity, floorPrice
                );
                if (stopResult.success) {
                    positions.updateStopPrice(ticker, floorPrice, stopResult.orderId);
                    stopUpdated = true;
                }
            }

            return res.json({
                status: 'heartbeat_ok',
                ticker,
                tradeId: pos.tradeId,
                remaining: pos.remainingQuantity,
                currentStop: positions.getStopPrice(ticker),
                stopUpdated,
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
    let actualFillPrice = entryPrice;
    let stopPlacedAt = 0;

    const result = await schwabService.placeBuyOrder(ticker, qty, entryPrice);

    if (result.success) {
        // v1.3.0: pass full body so position stores entry indicators
        positions.openPosition(ticker, entryPrice, qty, body);

        // v1.3.0: Place initial stop loss (2¢ below ACTUAL fill price)
        // Wait 2s for BUY to fill on Schwab before placing stop
        await new Promise(r => setTimeout(r, 2000));

        // Get actual fill price from Schwab (not Pine signal price)
        if (result.orderId) {
            const fillPrice = await schwabService.getOrderFillPrice(result.orderId);
            if (fillPrice > 0) {
                actualFillPrice = fillPrice;
                log('INFO', `${ticker}: signal $${entryPrice.toFixed(2)} → filled $${actualFillPrice.toFixed(2)}`);
                // Update position with real fill price
                const pos = positions.getPosition(ticker);
                if (pos) {
                    pos.entryPrice = actualFillPrice;
                    pos.entryData.signalPrice = entryPrice;
                    pos.entryData.fillPrice = actualFillPrice;
                }
            }
        }

        const stopCents = parseFloat(process.env.STOP_LOSS_CENTS || '0.02');
        stopPlacedAt = actualFillPrice - stopCents;
        if (stopPlacedAt > 0) {
            const stopResult = await schwabService.placeStopOrder(ticker, qty, stopPlacedAt);
            if (stopResult.success) {
                positions.setStopOrder(ticker, stopResult.orderId, stopPlacedAt);
            } else {
                log('WARN', `Stop order failed for ${ticker} — will retry on heartbeat`, {
                    stopPrice: stopPlacedAt.toFixed(2), error: stopResult.error
                });
            }
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
        fillPrice: actualFillPrice,
        stopPrice: stopPlacedAt,
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

    // v1.3.0: Cancel existing stop BEFORE selling (prevents overselling)
    const oldStopId = positions.getStopOrderId(ticker);
    if (oldStopId) {
        await schwabService.cancelOrder(oldStopId);
    }

    positions.markMilestone(ticker, level);
    const scaleResult = positions.scalePosition(ticker, sellPct, level, currentPrice);

    if (!scaleResult || scaleResult.sharesToSell <= 0) {
        log('WARN', `SCALE ${ticker}: nothing to sell`, {
            tradeId: pos.tradeId, level, sellPct, remaining: pos.remainingQuantity
        });
        // Re-place stop if we cancelled it but didn't sell
        const currentStop = positions.getStopPrice(ticker);
        if (currentStop > 0 && pos.remainingQuantity > 0) {
            const stopResult = await schwabService.placeStopOrder(ticker, pos.remainingQuantity, currentStop);
            if (stopResult.success) positions.updateStopPrice(ticker, currentStop, stopResult.orderId);
        }
        return { success: false, rejected: 'nothing to sell' };
    }

    const result = await schwabService.placeSellOrder(
        ticker, scaleResult.sharesToSell,
        `Scale ${level} (${sellPct}%)`, currentPrice
    );

    // v1.3.0: Place new stop for REMAINING shares at current floor
    const updatedPos = positions.getPosition(ticker);
    if (updatedPos && updatedPos.remainingQuantity > 0) {
        const currentStop = positions.getStopPrice(ticker);
        if (currentStop > 0) {
            const stopResult = await schwabService.placeStopOrder(
                ticker, updatedPos.remainingQuantity, currentStop
            );
            if (stopResult.success) {
                positions.updateStopPrice(ticker, currentStop, stopResult.orderId);
            }
        }
    }

    return {
        success: result.success,
        action: 'SCALE',
        tradeId: pos.tradeId,
        ticker, level,
        sharesSold: scaleResult.sharesToSell,
        remaining: updatedPos ? updatedPos.remainingQuantity : 0,
        scalePnL: scaleResult.pnl.toFixed(2),
        currentStop: positions.getStopPrice(ticker),
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
