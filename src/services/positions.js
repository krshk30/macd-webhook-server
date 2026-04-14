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
const { log, journalTrade, generateTradeId, setTradeId, clearTradeId } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ok */ }

// --- In-Memory State ---
const positions = new Map();
const pendingEntries = new Map();
let dailyPnL = 0, dailyTradeCount = 0, lastResetDate = new Date().toDateString();
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS || '5000');

function getInitialHardStop(entryPrice) {
    const stopPct = parseFloat(process.env.HARD_STOP_PCT || '0.01');
    const minCents = parseFloat(process.env.HARD_STOP_MIN_CENTS || '0.01');
    if (entryPrice <= 0) return 0;

    const stopDistance = Math.max(
        minCents,
        parseFloat((entryPrice * stopPct).toFixed(2))
    );

    return parseFloat((entryPrice - stopDistance).toFixed(2));
}

function buildEntryData(webhookData = {}) {
    return {
        path: webhookData.path || 'unknown',
        score: webhookData.score || null,
        stochK: webhookData.stochK || null,
        macd: webhookData.macd || null,
        hist: webhookData.hist || null,
        vwap: webhookData.vwap || null,
        ema9: webhookData.ema9 || null,
        ema20: webhookData.ema20 || null,
        volume: webhookData.volume || null
    };
}

function createPositionRecord(ticker, entryPrice, quantity, webhookData = {}, overrides = {}) {
    const tradeId = overrides.tradeId || generateTradeId(ticker);
    const enteredAt = overrides.enteredAt || new Date().toISOString();

    return {
        ticker,
        tradeId,
        entryPrice,
        initialQuantity: quantity,
        remainingQuantity: quantity,
        enteredAt,
        hit2pct: overrides.hit2pct || false,
        hitFast4pct: overrides.hitFast4pct || false,
        hit4after2: overrides.hit4after2 || false,
        soldPct: overrides.soldPct || 0,
        scaledExits: overrides.scaledExits || [],
        isOrphan: overrides.isOrphan || false,
        orphanDetectedAt: overrides.orphanDetectedAt || null,
        lastSignalTime: overrides.lastSignalTime || Date.now(),
        entryData: overrides.entryData || buildEntryData(webhookData),
        stopOrderId: overrides.stopOrderId || null,
        currentStopPrice: overrides.currentStopPrice || getInitialHardStop(entryPrice)
    };
}

// --- Persistence: Save ---
function saveToDisk() {
    try {
        const posData = {};
        for (const [k, v] of positions) { posData[k] = v; }
        const pendingData = {};
        for (const [k, v] of pendingEntries) { pendingData[k] = v; }
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(posData, null, 2));
        fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingData, null, 2));
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
        if (fs.existsSync(PENDING_FILE)) {
            const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
            let loaded = 0;
            for (const [ticker, entry] of Object.entries(raw)) {
                pendingEntries.set(ticker, entry);
                if (entry.tradeId) setTradeId(ticker, entry.tradeId);
                loaded++;
            }
            if (loaded > 0) {
                log('INFO', `Restored ${loaded} pending entr${loaded === 1 ? 'y' : 'ies'} from disk`, {
                    tickers: Object.keys(raw)
                });
            }
        }
    } catch (e) {
        log('WARN', 'Could not load pending entries from disk', { error: e.message });
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
    if (pendingEntries.has(ticker)) return { allowed: false, reason: `Pending entry for ${ticker}` };
    if ((positions.size + pendingEntries.size) >= parseInt(process.env.MAX_POSITIONS || '3')) return { allowed: false, reason: 'Max positions' };
    if (dailyPnL <= parseFloat(process.env.MAX_DAILY_LOSS || '-500')) return { allowed: false, reason: 'Daily loss limit' };
    if (!isWithinTradingHours()) return { allowed: false, reason: 'Outside trading hours' };
    return { allowed: true };
}

// --- Open Position ---
function openPosition(ticker, entryPrice, quantity, webhookData = {}, overrides = {}) {
    const pos = createPositionRecord(ticker, entryPrice, quantity, webhookData, overrides);
    setTradeId(ticker, pos.tradeId);
    positions.set(ticker, pos);
    pendingEntries.delete(ticker);
    dailyTradeCount++;
    saveToDisk();

    journalTrade({
        action: 'BUY',
        tradeId: pos.tradeId,
        ticker,
        entryPrice,
        quantity,
        ...pos.entryData
    });

    log('POSITION', `Opened ${ticker}: ${quantity} @ $${entryPrice.toFixed(2)}`, {
        tradeId: pos.tradeId, path: pos.entryData.path, score: pos.entryData.score
    });
}

function createPendingEntry(ticker, signalPrice, quantity, orderId, webhookData = {}, meta = {}) {
    const tradeId = generateTradeId(ticker);
    const pending = {
        ticker,
        tradeId,
        signalPrice,
        requestedQuantity: quantity,
        orderId,
        createdAt: new Date().toISOString(),
        lastSignalTime: Date.now(),
        session: meta.session || 'UNKNOWN',
        orderType: meta.orderType || 'UNKNOWN',
        entryData: buildEntryData(webhookData)
    };

    setTradeId(ticker, tradeId);
    pendingEntries.set(ticker, pending);
    saveToDisk();

    log('POSITION', `Pending entry ${ticker}: ${quantity} @ $${signalPrice.toFixed(2)}`, {
        tradeId,
        orderId,
        session: pending.session,
        orderType: pending.orderType
    });

    return pending;
}

function activatePendingEntry(ticker, entryPrice, quantity, details = {}) {
    const pending = pendingEntries.get(ticker);
    if (!pending) return null;

    const pos = createPositionRecord(
        ticker,
        entryPrice,
        quantity,
        pending.entryData,
        {
            tradeId: pending.tradeId,
            enteredAt: details.enteredAt || new Date().toISOString(),
            lastSignalTime: pending.lastSignalTime
        }
    );

    positions.set(ticker, pos);
    pendingEntries.delete(ticker);
    dailyTradeCount++;
    saveToDisk();

    journalTrade({
        action: 'BUY',
        tradeId: pos.tradeId,
        ticker,
        entryPrice,
        quantity,
        ...pos.entryData
    });

    log('POSITION', `Activated ${ticker}: ${quantity} @ $${entryPrice.toFixed(2)}`, {
        tradeId: pos.tradeId,
        orderId: pending.orderId,
        activationSource: details.source || 'unknown'
    });

    return pos;
}

function getPendingEntry(ticker) {
    return pendingEntries.get(ticker) || null;
}

function hasPendingEntry(ticker) {
    return pendingEntries.has(ticker);
}

function getAllPendingEntries() {
    return Array.from(pendingEntries.values());
}

function clearPendingEntry(ticker, reason = 'cleared') {
    const pending = pendingEntries.get(ticker);
    if (!pending) return null;
    pendingEntries.delete(ticker);
    clearTradeId(ticker);
    saveToDisk();
    log('POSITION', `Cleared pending entry ${ticker}`, {
        tradeId: pending.tradeId,
        reason,
        orderId: pending.orderId
    });
    return pending;
}

// --- Touch (Heartbeat) ---
function getPosition(ticker) { return positions.get(ticker) || null; }

function touchPosition(ticker) {
    const p = positions.get(ticker);
    if (p) {
        p.lastSignalTime = Date.now();
        return;
    }
    const pending = pendingEntries.get(ticker);
    if (pending) pending.lastSignalTime = Date.now();
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

function isMilestoneHit(ticker, milestone) {
    const p = positions.get(ticker);
    if (!p) return false;
    if (milestone === 'PCT2') return !!p.hit2pct;
    if (milestone === 'FAST4') return !!p.hitFast4pct;
    if (milestone === 'PCT4_AFTER2') return !!p.hit4after2;
    return false;
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
function previewScalePosition(ticker, sellPct, price = 0) {
    const p = positions.get(ticker);
    if (!p) return null;

    const sharesToSell = Math.min(
        Math.floor(p.initialQuantity * (sellPct / 100)),
        p.remainingQuantity
    );
    if (sharesToSell <= 0) {
        return { sharesToSell: 0, pnl: 0 };
    }

    return {
        sharesToSell,
        pnl: (price - p.entryPrice) * sharesToSell
    };
}

function scalePosition(ticker, sellPct, reason, price) {
    const p = positions.get(ticker);
    if (!p) return null;

    const preview = previewScalePosition(ticker, sellPct, price);
    const sell = preview?.sharesToSell || 0;
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
        pendingEntries: Array.from(pendingEntries.values()).map(p => ({
            ticker: p.ticker,
            tradeId: p.tradeId,
            signalPrice: p.signalPrice,
            requestedQuantity: p.requestedQuantity,
            orderId: p.orderId,
            session: p.session,
            orderType: p.orderType,
            ageSecs: Math.round((Date.now() - new Date(p.createdAt).getTime()) / 1000)
        })),
        positionCount: positions.size,
        pendingCount: pendingEntries.size,
        dailyPnL: dailyPnL.toFixed(2),
        dailyTradeCount,
        maxPositions: parseInt(process.env.MAX_POSITIONS || '3')
    };
}

module.exports = {
    positions: {
        isDuplicate, canOpenPosition, openPosition,
        createPendingEntry, activatePendingEntry, getPendingEntry, hasPendingEntry, getAllPendingEntries, clearPendingEntry,
        getPosition,
        touchPosition, setStopOrder, getStopPrice, getStopOrderId, updateStopPrice,
        getHeartbeatExpired, previewScalePosition, scalePosition, closePosition,
        markMilestone, isMilestoneHit, getStatus, getAllPositions, markOrphan, getOrphans
    }
};
