const { log } = require('./logger');
const positions = new Map();
let dailyPnL = 0, dailyTradeCount = 0, lastResetDate = new Date().toDateString();
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = 5000;
function resetDailyIfNeeded() { const t = new Date().toDateString(); if (t !== lastResetDate) { dailyPnL = 0; dailyTradeCount = 0; lastResetDate = t; log('INFO', 'Daily P&L reset'); } }
function isDuplicate(ticker, action) { const k = `${ticker}:${action}`, now = Date.now(), last = recentAlerts.get(k); if (last && (now - last) < DEDUP_WINDOW_MS) { log('WARN', `Duplicate filtered: ${k}`); return true; } recentAlerts.set(k, now); for (const [k2, t] of recentAlerts) { if (now - t > DEDUP_WINDOW_MS * 2) recentAlerts.delete(k2); } return false; }
function isWithinTradingHours() { const e = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); const h = e.getHours(), m = e.getMinutes(); const s = parseInt(process.env.TRADING_START_HOUR || '7'), en = parseInt(process.env.TRADING_END_HOUR || '18'); log('DEBUG', `Trading hours: ${h}:${m.toString().padStart(2,'0')} ET (${s}:00-${en}:00)`); return h >= s && h < en; }
function canOpenPosition(ticker) { resetDailyIfNeeded(); if (positions.has(ticker)) return { allowed: false, reason: `Already holding ${ticker}` }; if (positions.size >= parseInt(process.env.MAX_POSITIONS || '3')) return { allowed: false, reason: 'Max positions' }; if (dailyPnL <= parseFloat(process.env.MAX_DAILY_LOSS || '-500')) return { allowed: false, reason: 'Daily loss limit' }; if (!isWithinTradingHours()) return { allowed: false, reason: 'Outside trading hours' }; return { allowed: true }; }
function openPosition(ticker, entryPrice, quantity) {
    positions.set(ticker, { ticker, entryPrice, initialQuantity: quantity, remainingQuantity: quantity, enteredAt: new Date().toISOString(), hit2pct: false, hitFast4pct: false, hit4after2: false, soldPct: 0, scaledExits: [], isOrphan: false, orphanDetectedAt: null,
        lastSignalTime: Date.now()  // v1.2.8: heartbeat tracking
    });
    dailyTradeCount++;
    log('POSITION', `Opened ${ticker}: ${quantity} shares @ $${entryPrice.toFixed(2)}`);
}
function getPosition(ticker) { return positions.get(ticker) || null; }
// v1.2.8: Update heartbeat timestamp
function touchPosition(ticker) { const p = positions.get(ticker); if (p) { p.lastSignalTime = Date.now(); } }
// v1.2.8: Get positions with expired heartbeat
function getHeartbeatExpired(timeoutSecs) {
    const result = [], now = Date.now();
    for (const p of positions.values()) {
        if (p.lastSignalTime && (now - p.lastSignalTime) / 1000 >= timeoutSecs && !p.isOrphan) result.push(p);
    }
    return result;
}
function markOrphan(ticker) { const p = positions.get(ticker); if (p) { p.isOrphan = true; p.orphanDetectedAt = new Date(); log('WARN', `Marked ${ticker} orphan`); } }
function getOrphans(mins) { const r = [], now = Date.now(); for (const p of positions.values()) { if (p.isOrphan && p.orphanDetectedAt && (now - new Date(p.orphanDetectedAt).getTime()) / 60000 >= mins) r.push(p); } return r; }
function scalePosition(ticker, sellPct, reason, price) { const p = positions.get(ticker); if (!p) return null; const sell = Math.min(Math.floor(p.initialQuantity * (sellPct / 100)), p.remainingQuantity); if (sell <= 0) { log('WARN', `Scale ${ticker}: 0 shares`); return null; } p.remainingQuantity -= sell; p.soldPct += sellPct; p.scaledExits.push({ reason, shares: sell, price, time: new Date().toISOString() }); const pnl = (price - p.entryPrice) * sell; dailyPnL += pnl; p.lastSignalTime = Date.now(); log('POSITION', `Scaled ${ticker}: sold ${sell}/${p.initialQuantity} (${reason}) | remaining: ${p.remainingQuantity} | P&L: $${pnl.toFixed(2)}`); return { sharesToSell: sell, pnl }; }
function closePosition(ticker, exitPrice, reason) { const p = positions.get(ticker); if (!p) return null; const rem = p.remainingQuantity, pnl = (exitPrice - p.entryPrice) * rem; dailyPnL += pnl; const s = { ticker, entryPrice: p.entryPrice, exitPrice, totalShares: p.initialQuantity, remainingClosed: rem, reason, pnl, scaledExits: p.scaledExits }; positions.delete(ticker); log('POSITION', `Closed ${ticker}: ${rem} shares @ $${exitPrice.toFixed(2)} | P&L: $${pnl.toFixed(2)} | ${reason}`); return s; }
function markMilestone(ticker, m) { const p = positions.get(ticker); if (!p) return; if (m === 'PCT2') p.hit2pct = true; else if (m === 'FAST4') p.hitFast4pct = true; else if (m === 'PCT4_AFTER2') p.hit4after2 = true; }
function getStatus() { resetDailyIfNeeded(); return { openPositions: Array.from(positions.values()).map(p => ({ ticker: p.ticker, entryPrice: p.entryPrice, remaining: p.remainingQuantity, soldPct: p.soldPct, enteredAt: p.enteredAt, isOrphan: p.isOrphan, lastSignalAge: Math.round((Date.now() - (p.lastSignalTime || 0)) / 1000) + 's' })), positionCount: positions.size, dailyPnL: dailyPnL.toFixed(2), dailyTradeCount, maxPositions: parseInt(process.env.MAX_POSITIONS || '3') }; }
module.exports = { positions: { isDuplicate, canOpenPosition, openPosition, getPosition, touchPosition, getHeartbeatExpired, scalePosition, closePosition, markMilestone, getStatus, markOrphan, getOrphans } };
