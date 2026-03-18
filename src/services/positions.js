const { log } = require('./logger');
const positions = new Map();
let dailyPnL = 0, dailyTradeCount = 0, lastResetDate = new Date().toDateString();
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = 5000;

function resetDailyIfNeeded() { const today = new Date().toDateString(); if (today !== lastResetDate) { dailyPnL = 0; dailyTradeCount = 0; lastResetDate = today; log('INFO', 'Daily P&L reset'); } }

function isDuplicate(ticker, action) {
    const key = `${ticker}:${action}`; const now = Date.now(); const lastTime = recentAlerts.get(key);
    if (lastTime && (now - lastTime) < DEDUP_WINDOW_MS) { log('WARN', `Duplicate filtered: ${key}`); return true; }
    recentAlerts.set(key, now);
    for (const [k, t] of recentAlerts) { if (now - t > DEDUP_WINDOW_MS * 2) recentAlerts.delete(k); }
    return false;
}

function isWithinTradingHours() {
    const eastern = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = eastern.getHours(), minute = eastern.getMinutes();
    const s = parseInt(process.env.TRADING_START_HOUR || '7'), e = parseInt(process.env.TRADING_END_HOUR || '18');
    log('DEBUG', `Trading hours: ${hour}:${minute.toString().padStart(2,'0')} ET (${s}:00-${e}:00)`);
    return hour >= s && hour < e;
}

function canOpenPosition(ticker) {
    resetDailyIfNeeded();
    if (positions.has(ticker)) return { allowed: false, reason: `Already holding ${ticker}` };
    if (positions.size >= parseInt(process.env.MAX_POSITIONS || '3')) return { allowed: false, reason: `Max positions` };
    if (dailyPnL <= parseFloat(process.env.MAX_DAILY_LOSS || '-500')) return { allowed: false, reason: `Daily loss limit` };
    if (!isWithinTradingHours()) return { allowed: false, reason: 'Outside trading hours' };
    return { allowed: true };
}

function openPosition(ticker, entryPrice, quantity) {
    positions.set(ticker, { ticker, entryPrice, initialQuantity: quantity, remainingQuantity: quantity, enteredAt: new Date().toISOString(), hit2pct: false, hitFast4pct: false, hit4after2: false, soldPct: 0, scaledExits: [], isOrphan: false, orphanDetectedAt: null });
    dailyTradeCount++;
    log('POSITION', `Opened ${ticker}: ${quantity} shares @ $${entryPrice.toFixed(2)}`);
}

function getPosition(ticker) { return positions.get(ticker) || null; }

function markOrphan(ticker) { const pos = positions.get(ticker); if (pos) { pos.isOrphan = true; pos.orphanDetectedAt = new Date(); log('WARN', `Marked ${ticker} as orphan`); } }

function getOrphans(timeoutMins) {
    const result = [], now = Date.now();
    for (const pos of positions.values()) { if (pos.isOrphan && pos.orphanDetectedAt && (now - new Date(pos.orphanDetectedAt).getTime()) / 60000 >= timeoutMins) result.push(pos); }
    return result;
}

function scalePosition(ticker, sellPct, reason, currentPrice) {
    const pos = positions.get(ticker); if (!pos) return null;
    const sharesToSell = Math.floor(pos.initialQuantity * (sellPct / 100));
    const actualSell = Math.min(sharesToSell, pos.remainingQuantity);
    if (actualSell <= 0) { log('WARN', `Scale ${ticker}: 0 shares`); return null; }
    pos.remainingQuantity -= actualSell; pos.soldPct += sellPct;
    pos.scaledExits.push({ reason, shares: actualSell, price: currentPrice, time: new Date().toISOString() });
    const pnl = (currentPrice - pos.entryPrice) * actualSell; dailyPnL += pnl;
    log('POSITION', `Scaled ${ticker}: sold ${actualSell}/${pos.initialQuantity} (${reason}) | remaining: ${pos.remainingQuantity} | P&L: $${pnl.toFixed(2)}`);
    return { sharesToSell: actualSell, pnl };
}

function closePosition(ticker, exitPrice, reason) {
    const pos = positions.get(ticker); if (!pos) return null;
    const remaining = pos.remainingQuantity;
    const pnl = (exitPrice - pos.entryPrice) * remaining; dailyPnL += pnl;
    const summary = { ticker, entryPrice: pos.entryPrice, exitPrice, totalShares: pos.initialQuantity, remainingClosed: remaining, reason, pnl, scaledExits: pos.scaledExits };
    positions.delete(ticker);
    log('POSITION', `Closed ${ticker}: ${remaining} shares @ $${exitPrice.toFixed(2)} | P&L: $${pnl.toFixed(2)} | ${reason}`);
    return summary;
}

function markMilestone(ticker, milestone) {
    const pos = positions.get(ticker); if (!pos) return;
    if (milestone === 'PCT2') pos.hit2pct = true;
    else if (milestone === 'FAST4') pos.hitFast4pct = true;
    else if (milestone === 'PCT4_AFTER2') pos.hit4after2 = true;
}

function getStatus() {
    resetDailyIfNeeded();
    return { openPositions: Array.from(positions.values()).map(p => ({ ticker: p.ticker, entryPrice: p.entryPrice, remaining: p.remainingQuantity, soldPct: p.soldPct, enteredAt: p.enteredAt, isOrphan: p.isOrphan })),
        positionCount: positions.size, dailyPnL: dailyPnL.toFixed(2), dailyTradeCount, maxPositions: parseInt(process.env.MAX_POSITIONS || '3'), maxDailyLoss: process.env.MAX_DAILY_LOSS || '-500' };
}

module.exports = { positions: { isDuplicate, canOpenPosition, openPosition, getPosition, scalePosition, closePosition, markMilestone, getStatus, markOrphan, getOrphans } };
