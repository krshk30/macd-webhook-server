/**
 * Position Tracking Service
 * In-memory position state — no database latency
 * Tracks entries, scaled exits, milestones, and daily P&L
 */

const { log } = require('./logger');

// Position state per ticker
const positions = new Map();

// Daily P&L tracking
let dailyPnL = 0;
let dailyTradeCount = 0;
let lastResetDate = new Date().toDateString();

// Duplicate alert filter (5-second window)
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = 5000;

function resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        dailyPnL = 0;
        dailyTradeCount = 0;
        lastResetDate = today;
        log('INFO', 'Daily P&L reset');
    }
}

function isDuplicate(ticker, action) {
    const key = `${ticker}:${action}`;
    const now = Date.now();
    const lastTime = recentAlerts.get(key);

    if (lastTime && (now - lastTime) < DEDUP_WINDOW_MS) {
        log('WARN', `Duplicate alert filtered: ${key} (within ${DEDUP_WINDOW_MS}ms)`);
        return true;
    }

    recentAlerts.set(key, now);

    // Clean old entries
    for (const [k, t] of recentAlerts) {
        if (now - t > DEDUP_WINDOW_MS * 2) recentAlerts.delete(k);
    }

    return false;
}

function isWithinTradingHours() {
    const now = new Date();
    const hour = now.getHours();
    const startHour = parseInt(process.env.TRADING_START_HOUR || '7');
    const endHour = parseInt(process.env.TRADING_END_HOUR || '16');
    return hour >= startHour && hour < endHour;
}

function canOpenPosition(ticker) {
    resetDailyIfNeeded();

    if (positions.has(ticker)) {
        return { allowed: false, reason: `Already holding ${ticker}` };
    }

    const maxPos = parseInt(process.env.MAX_POSITIONS || '3');
    if (positions.size >= maxPos) {
        return { allowed: false, reason: `Max positions reached (${positions.size}/${maxPos})` };
    }

    const maxLoss = parseFloat(process.env.MAX_DAILY_LOSS || '-500');
    if (dailyPnL <= maxLoss) {
        return { allowed: false, reason: `Daily loss limit reached ($${dailyPnL.toFixed(2)})` };
    }

    if (!isWithinTradingHours()) {
        return { allowed: false, reason: 'Outside trading hours' };
    }

    return { allowed: true };
}

function openPosition(ticker, entryPrice, quantity) {
    positions.set(ticker, {
        ticker,
        entryPrice,
        initialQuantity: quantity,
        remainingQuantity: quantity,
        enteredAt: new Date().toISOString(),
        hit2pct: false,
        hitFast4pct: false,
        hit4after2: false,
        soldPct: 0,
        scaledExits: []
    });

    dailyTradeCount++;
    log('POSITION', `Opened ${ticker}: ${quantity} shares @ $${entryPrice.toFixed(2)}`);
}

function getPosition(ticker) {
    return positions.get(ticker) || null;
}

function scalePosition(ticker, sellPct, reason, currentPrice) {
    const pos = positions.get(ticker);
    if (!pos) return null;

    const sharesToSell = Math.floor(pos.initialQuantity * (sellPct / 100));
    const actualSell = Math.min(sharesToSell, pos.remainingQuantity);

    if (actualSell <= 0) return null;

    pos.remainingQuantity -= actualSell;
    pos.soldPct += sellPct;
    pos.scaledExits.push({
        reason,
        shares: actualSell,
        price: currentPrice,
        time: new Date().toISOString()
    });

    const scalePnL = (currentPrice - pos.entryPrice) * actualSell;
    dailyPnL += scalePnL;

    log('POSITION', `Scaled ${ticker}: sold ${actualSell} shares (${reason}) | P&L: $${scalePnL.toFixed(2)}`);

    return { sharesToSell: actualSell, pnl: scalePnL };
}

function closePosition(ticker, exitPrice, reason) {
    const pos = positions.get(ticker);
    if (!pos) return null;

    const remaining = pos.remainingQuantity;
    const pnl = (exitPrice - pos.entryPrice) * remaining;
    dailyPnL += pnl;

    const summary = {
        ticker,
        entryPrice: pos.entryPrice,
        exitPrice,
        totalShares: pos.initialQuantity,
        remainingClosed: remaining,
        reason,
        pnl,
        holdTime: new Date() - new Date(pos.enteredAt),
        scaledExits: pos.scaledExits
    };

    positions.delete(ticker);

    log('POSITION', `Closed ${ticker}: ${remaining} remaining @ $${exitPrice.toFixed(2)} | P&L: $${pnl.toFixed(2)} | ${reason}`);

    return summary;
}

function markMilestone(ticker, milestone) {
    const pos = positions.get(ticker);
    if (!pos) return;

    switch (milestone) {
        case 'PCT2':
            pos.hit2pct = true;
            break;
        case 'FAST4':
            pos.hitFast4pct = true;
            break;
        case 'PCT4_AFTER2':
            pos.hit4after2 = true;
            break;
    }
}

function getStatus() {
    resetDailyIfNeeded();

    return {
        openPositions: Array.from(positions.values()).map(p => ({
            ticker: p.ticker,
            entryPrice: p.entryPrice,
            remaining: p.remainingQuantity,
            soldPct: p.soldPct,
            enteredAt: p.enteredAt
        })),
        positionCount: positions.size,
        dailyPnL: dailyPnL.toFixed(2),
        dailyTradeCount,
        maxPositions: parseInt(process.env.MAX_POSITIONS || '3'),
        maxDailyLoss: process.env.MAX_DAILY_LOSS || '-500'
    };
}

module.exports = {
    positions: {
        isDuplicate,
        canOpenPosition,
        openPosition,
        getPosition,
        scalePosition,
        closePosition,
        markMilestone,
        getStatus
    }
};
