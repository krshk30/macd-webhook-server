/**
 * Logger Service v1.3.0
 * 
 * Structured JSON logging with:
 *   - Trade IDs for tracing entire trade lifecycle
 *   - JSON log lines for Railway log parsing / export
 *   - Console-friendly format AND structured data
 *   - Trade journal: every BUY/SCALE/CLOSE/HEARTBEAT_EXPIRED written to daily file
 *   - Daily summary generation
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const JOURNAL_DIR = path.join(LOG_DIR, 'journal');
const ENABLE_FILE_LOG = process.env.ENABLE_FILE_LOG !== 'false'; // default ON

// Ensure directories exist
try {
    if (ENABLE_FILE_LOG) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    }
} catch (e) { /* Railway may not have writable fs — fall back to console only */ }

// --- Trade ID Generator ---
let tradeIdCounter = 0;
function generateTradeId(ticker) {
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    tradeIdCounter++;
    return `T-${dateStr}-${ticker}-${String(tradeIdCounter).padStart(3, '0')}`;
}

// --- Active Trade IDs (ticker → tradeId) ---
const activeTradeIds = new Map();

function setTradeId(ticker, tradeId) { activeTradeIds.set(ticker, tradeId); }
function getTradeId(ticker) { return activeTradeIds.get(ticker) || null; }
function clearTradeId(ticker) { activeTradeIds.delete(ticker); }

// --- Core Log Function ---
function log(level, message, data = null) {
    const ts = new Date().toISOString();
    const etTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

    // Console output: human-readable
    const consoleMsg = data
        ? `[${ts}] [${level}] ${message} | ${JSON.stringify(data)}`
        : `[${ts}] [${level}] ${message}`;
    setImmediate(() => console.log(consoleMsg));

    // File output: structured JSON (one line per entry)
    if (ENABLE_FILE_LOG) {
        const entry = {
            ts,
            et: etTime,
            level,
            message,
            ...(data || {})
        };
        const dateStr = ts.substring(0, 10); // YYYY-MM-DD
        const logFile = path.join(LOG_DIR, `${dateStr}.jsonl`);
        try {
            fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
        } catch (e) { /* silently skip file write failures */ }
    }
}

// --- Trade Journal: structured trade events ---
function journalTrade(event) {
    const ts = new Date().toISOString();
    const entry = { ts, ...event };

    // Always log to console
    log('TRADE', `${event.action} ${event.ticker}`, event);

    // Write to daily journal file
    if (ENABLE_FILE_LOG) {
        const dateStr = ts.substring(0, 10);
        const journalFile = path.join(JOURNAL_DIR, `trades-${dateStr}.jsonl`);
        try {
            fs.appendFileSync(journalFile, JSON.stringify(entry) + '\n');
        } catch (e) { /* skip */ }
    }
}

// --- Daily Summary ---
function getDailySummary(dateStr) {
    if (!dateStr) dateStr = new Date().toISOString().substring(0, 10);
    const journalFile = path.join(JOURNAL_DIR, `trades-${dateStr}.jsonl`);

    try {
        const lines = fs.readFileSync(journalFile, 'utf8').trim().split('\n');
        const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        const buys = trades.filter(t => t.action === 'BUY');
        const closes = trades.filter(t => t.action === 'CLOSE');
        const scales = trades.filter(t => t.action === 'SCALE');
        const heartbeatExpired = trades.filter(t => t.action === 'HEARTBEAT_EXPIRED');

        let totalPnL = 0, winners = 0, losers = 0;
        for (const c of closes) {
            const pnl = parseFloat(c.pnl) || 0;
            totalPnL += pnl;
            if (pnl >= 0) winners++; else losers++;
        }
        for (const s of scales) {
            totalPnL += parseFloat(s.pnl) || 0;
        }

        return {
            date: dateStr,
            totalTrades: buys.length,
            closedTrades: closes.length,
            scaleExits: scales.length,
            heartbeatExpired: heartbeatExpired.length,
            winners,
            losers,
            winRate: closes.length > 0 ? ((winners / closes.length) * 100).toFixed(1) + '%' : 'N/A',
            totalPnL: totalPnL.toFixed(2),
            trades: trades
        };
    } catch (e) {
        return { date: dateStr, error: 'No journal data', trades: [] };
    }
}

// --- Get Recent Logs ---
function getRecentLogs(n = 50) {
    const dateStr = new Date().toISOString().substring(0, 10);
    const logFile = path.join(LOG_DIR, `${dateStr}.jsonl`);
    try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch (e) {
        return [];
    }
}

module.exports = {
    log,
    journalTrade,
    generateTradeId,
    setTradeId,
    getTradeId,
    clearTradeId,
    getDailySummary,
    getRecentLogs
};
