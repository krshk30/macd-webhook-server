/**
 * Position Tracker v1.3.0
 * 
 * Changes from v1.2.9:
 *   - File-based persistence: positions saved to disk on every change
 *   - On startup, loads positions from last saved state
 *   - Trade IDs: every position gets a unique ID for lifecycle tracing
 *   - Journal integration: all trade events logged to daily journal
 *   - Railway restart safe: no more orphan chaos on deploys
 *   - Daily P&L also persisted
 */
const fs = require('fs');
const path = require('path');
const { log, journalTrade, generateTradeId, setTradeId, getTradeId, clearTradeId } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ok */ }

// --- In-Memory State ---
const positions = new Map();
let dailyPnL = 0, dailyTradeCount = 0, lastResetDate = new Date().toDateString();
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS || '5000');

// --- Persistence: Save ---
function saveToDisk() {
    try {
        const posData = {};
        for (const [k, v] of positions) { posData[k] = v; }
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(posData, null, 2));
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            dailyPnL, dailyTradeCount, lastResetDate,
            savedAt: new Date().toISOString()
        }, null, 2));
    } catch (e) {
        log('WARN', 'Failed to save positions to disk', { error: e.message });
    }
}

// --- Persistence: Load on Startup ---
function loadFromDisk() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
            let loaded = 0;
            for (const [ticker, pos] of Object.entries(raw)) {
                positions.set(ticker, pos);
                if (pos.tradeId) setTradeId(ticker, pos.tradeId);
                loaded++;
            }
            if (loaded > 0) {
                log('INFO', `Restored ${loaded} position(s) from disk`, {
                    tickers: Object.keys(raw)
                });
            }
        }
    } catch (e) {
        log('WARN', 'Could not load positions from disk', { error: e.message });
    }

    try {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            // Only restore if same day
            if (state.lastResetDate === new Date().toDateString()) {
                dailyPnL = state.dailyPnL || 0;
                dailyTradeCount = state.dailyTradeCount || 0;
                lastResetDate = state.lastResetDate;
                log('INFO', `Restored daily state: P&L $${dailyPnL.toFixed(2)}, trades: ${dailyTradeCount}`);
            } else {
                log('INFO', 'New trading day — daily state reset');
            }
        }
    } catch (e) { /* fresh start */ }
}

// Load immediately on require
loadFromDisk();

// --- Daily Reset ---
function resetDailyIfNeeded() {
    const t = new Date().toDateString();
    if (t !== lastResetDate) {
        log('INFO', `Daily P&L reset: was $${dailyPnL.toFixed(2)} over ${dailyTradeCount} trades`);
        dailyPnL = 0;
        dailyTradeCount = 0;
        lastResetDate = t;
        saveToDisk();
    }
}

// --- Dedup ---
function isDuplicate(ticker, action) {
    const k = `${ticker}:${action}`, now = Date.now(), last = recentAlerts.get(k);
    if (last && (now - last) < DEDUP_WINDOW_MS) {
        log('DEDUP', `Filtered duplicate: ${k}`, { agems: now - last });
        return true;
    }
    recentAlerts.set(k, now);
    // Cleanup old entries
    for (const [k2, t] of recentAlerts) {
        if (now - t > DEDUP_WINDOW_MS * 2) recentAlerts.delete(k2);
    }
    return false;
}

// --- Trading Hours ---
function isWithinTradingHours() {
    const e = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = e.getHours(), m = e.getMinutes();
    const s = parseInt(process.env.TRADING_START_HOUR || '7');
    const en = parseInt(process.env.TRADING_END_HOUR || '18');
    return h >= s && h < en;
}

// --- Position Guards ---
function canOpenPosition(ticker) {
    resetDailyIfNeeded();
    if (positions.has(ticker)) return { allowed: false, reason: `Already holding ${ticker}` };
    if (positions.size >= parseInt(process.env.MAX_POSITIONS || '3')) return { allowed: false, reason: 'Max positions' };
    if (dailyPnL <= parseFloat(process.env.MAX_DAILY_LOSS || '-500')) return { allowed: false, reason: 'Daily loss limit' };
    if (!isWithinTradingHours()) return { allowed: false, reason: 'Outside trading hours' };
    return { allowed: true };
}

// --- Open Position ---
function openPosition(ticker, entryPrice, quantity, webhookData = {}) {
    const tradeId = generateTradeId(ticker);
    setTradeId(ticker, tradeId);

    const pos = {
        ticker,
        tradeId,
        entryPrice,
        initialQuantity: quantity,
        remainingQuantity: quantity,
        enteredAt: new Date().toISOString(),
        hit2pct: false,
        hitFast4pct: false,
        hit4after2: false,
        soldPct: 0,
        scaledExits: [],
        isOrphan: false,
        orphanDetectedAt: null,
        lastSignalTime: Date.now(),
        // v1.3.0: Store the full webhook data for post-analysis
        entryData: {
            path: webhookData.path || 'unknown',
            score: webhookData.score || null,
            stochK: webhookData.stochK || null,
            macd: webhookData.macd || null,
            hist: webhookData.hist || null,
            vwap: webhookData.vwap || null,
            ema9: webhookData.ema9 || null,
            ema20: webhookData.ema20 || null,
            volume: webhookData.volume || null
        },
        // v1.3.0: Stop loss tracking
        stopOrderId: null,
        currentStopPrice: 0
    };

    positions.set(ticker, pos);
    dailyTradeCount++;
    saveToDisk();

    journalTrade({
        action: 'BUY',
        tradeId,
        ticker,
        entryPrice,
        quantity,
        ...pos.entryData
    });

    log('POSITION', `Opened ${ticker}: ${quantity} @ $${entryPrice.toFixed(2)}`, {
        tradeId, path: pos.entryData.path, score: pos.entryData.score
    });
}

// --- Touch (Heartbeat) ---
function getPosition(ticker) { return positions.get(ticker) || null; }

function touchPosition(ticker) {
    const p = positions.get(ticker);
    if (p) { p.lastSignalTime = Date.now(); }
}

// v1.3.0: Stop loss tracking
function setStopOrder(ticker, orderId, stopPrice) {
    const p = positions.get(ticker);
    if (p) {
        p.stopOrderId = orderId;
        p.currentStopPrice = stopPrice;
        saveToDisk();
        log('STOP', `Set stop for ${ticker}: $${stopPrice.toFixed(2)}`, {
            tradeId: p.tradeId, orderId
        });
    }
}

function getStopPrice(ticker) {
    const p = positions.get(ticker);
    return p ? p.currentStopPrice : 0;
}

function getStopOrderId(ticker) {
    const p = positions.get(ticker);
    return p ? p.stopOrderId : null;
}

function updateStopPrice(ticker, newStopPrice, newOrderId) {
    const p = positions.get(ticker);
    if (p) {
        const oldPrice = p.currentStopPrice;
        p.currentStopPrice = newStopPrice;
        if (newOrderId) p.stopOrderId = newOrderId;
        saveToDisk();
        log('STOP', `Ratcheted stop for ${ticker}: $${oldPrice.toFixed(2)} → $${newStopPrice.toFixed(2)}`, {
            tradeId: p.tradeId
        });
    }
}

// --- Heartbeat Expired ---
function getHeartbeatExpired(timeoutSecs) {
    const r = [], now = Date.now();
    for (const p of positions.values()) {
        if (p.lastSignalTime && (now - p.lastSignalTime) / 1000 >= timeoutSecs && !p.isOrphan) {
            r.push(p);
        }
    }
    return r;
}

// --- Orphan Management ---
function markOrphan(ticker) {
    const p = positions.get(ticker);
    if (p) {
        p.isOrphan = true;
        p.orphanDetectedAt = new Date().toISOString();
        saveToDisk();
        log('WARN', `Marked ${ticker} orphan`, { tradeId: p.tradeId });
    }
}

function getOrphans(mins) {
    const r = [], now = Date.now();
    for (const p of positions.values()) {
        if (p.isOrphan && p.orphanDetectedAt &&
            (now - new Date(p.orphanDetectedAt).getTime()) / 60000 >= mins) {
            r.push(p);
        }
    }
    return r;
}

// --- Scale Position ---
function scalePosition(ticker, sellPct, reason, price) {
    const p = positions.get(ticker);
    if (!p) return null;

    const sell = Math.min(
        Math.floor(p.initialQuantity * (sellPct / 100)),
        p.remainingQuantity
    );
    if (sell <= 0) {
        log('WARN', `Scale ${ticker}: 0 shares to sell`, {
            tradeId: p.tradeId, sellPct, remaining: p.remainingQuantity
        });
        return null;
    }

    p.remainingQuantity -= sell;
    p.soldPct += sellPct;
    const pnl = (price - p.entryPrice) * sell;
    dailyPnL += pnl;
    p.lastSignalTime = Date.now();

    const scaleEntry = { reason, shares: sell, price, pnl, time: new Date().toISOString() };
    p.scaledExits.push(scaleEntry);
    saveToDisk();

    journalTrade({
        action: 'SCALE',
        tradeId: p.tradeId,
        ticker,
        level: reason,
        sharesSold: sell,
        remaining: p.remainingQuantity,
        entryPrice: p.entryPrice,
        exitPrice: price,
        pnl: pnl.toFixed(2),
        profitPct: ((price - p.entryPrice) / p.entryPrice * 100).toFixed(2)
    });

    log('POSITION', `Scaled ${ticker}: sold ${sell}/${p.initialQuantity} (${reason})`, {
        tradeId: p.tradeId, remaining: p.remainingQuantity, pnl: pnl.toFixed(2)
    });

    return { sharesToSell: sell, pnl };
}

// --- Close Position ---
function closePosition(ticker, exitPrice, reason) {
    const p = positions.get(ticker);
    if (!p) return null;

    const rem = p.remainingQuantity;
    const pnl = (exitPrice - p.entryPrice) * rem;
    dailyPnL += pnl;

    // Calculate total P&L including scaled exits
    let totalScaledPnL = 0;
    for (const s of p.scaledExits) {
        totalScaledPnL += (s.pnl || 0);
    }
    const totalPnL = pnl + totalScaledPnL;

    // Hold duration
    const holdMs = Date.now() - new Date(p.enteredAt).getTime();
    const holdMins = (holdMs / 60000).toFixed(1);

    const summary = {
        ticker,
        tradeId: p.tradeId,
        entryPrice: p.entryPrice,
        exitPrice,
        totalShares: p.initialQuantity,
        remainingClosed: rem,
        reason,
        pnl,              // P&L on remaining shares only
        totalPnL,         // P&L including scales
        scaledExits: p.scaledExits,
        holdMinutes: holdMins,
        entryData: p.entryData
    };

    journalTrade({
        action: 'CLOSE',
        tradeId: p.tradeId,
        ticker,
        reason,
        entryPrice: p.entryPrice,
        exitPrice,
        sharesClosed: rem,
        pnl: pnl.toFixed(2),
        totalPnL: totalPnL.toFixed(2),
        holdMinutes: holdMins,
        scaledExits: p.scaledExits.length,
        entryPath: p.entryData?.path,
        entryScore: p.entryData?.score
    });

    log('POSITION', `Closed ${ticker}: ${rem} @ $${exitPrice.toFixed(2)}`, {
        tradeId: p.tradeId, reason, pnl: pnl.toFixed(2),
        totalPnL: totalPnL.toFixed(2), holdMins
    });

    clearTradeId(ticker);
    positions.delete(ticker);
    saveToDisk();

    return summary;
}

// --- Milestones ---
function markMilestone(ticker, m) {
    const p = positions.get(ticker);
    if (!p) return;
    if (m === 'PCT2') p.hit2pct = true;
    else if (m === 'FAST4') p.hitFast4pct = true;
    else if (m === 'PCT4_AFTER2') p.hit4after2 = true;
    saveToDisk();
}

// --- Status ---
function getAllPositions() {
    return Array.from(positions.values());
}

function getStatus() {
    resetDailyIfNeeded();
    return {
        openPositions: Array.from(positions.values()).map(p => ({
            ticker: p.ticker,
            tradeId: p.tradeId,
            entryPrice: p.entryPrice,
            remaining: p.remainingQuantity,
            soldPct: p.soldPct,
            enteredAt: p.enteredAt,
            isOrphan: p.isOrphan,
            lastSignalAge: Math.round((Date.now() - (p.lastSignalTime || 0)) / 1000) + 's',
            entryPath: p.entryData?.path,
            entryScore: p.entryData?.score
        })),
        positionCount: positions.size,
        dailyPnL: dailyPnL.toFixed(2),
        dailyTradeCount,
        maxPositions: parseInt(process.env.MAX_POSITIONS || '3')
    };
}

module.exports = {
    positions: {
        isDuplicate, canOpenPosition, openPosition, getPosition,
        touchPosition, setStopOrder, getStopPrice, getStopOrderId, updateStopPrice,
        getHeartbeatExpired, scalePosition, closePosition,
        markMilestone, getStatus, getAllPositions, markOrphan, getOrphans
    }
};
