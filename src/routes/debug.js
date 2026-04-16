const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { log, getDailySummary, getRecentLogs } = require('../services/logger');

const router = express.Router();
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const JOURNAL_DIR = path.join(LOG_DIR, 'journal');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(date) {
    return DATE_RE.test(date);
}

function safeReadDir(dirPath) {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return [];
    }
}

function safeReadFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function parseJsonLines(raw) {
    if (!raw || !raw.trim()) return [];
    return raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { raw: line };
            }
        });
}

function formatLogEntries(entries) {
    return entries
        .map(entry => {
            const ts = entry.ts || '-';
            const level = entry.level || 'INFO';
            const message = entry.message || '';
            const extra = { ...entry };
            delete extra.ts;
            delete extra.et;
            delete extra.level;
            delete extra.message;
            const suffix = Object.keys(extra).length ? ` | ${JSON.stringify(extra)}` : '';
            return `[${ts}] [${level}] ${message}${suffix}`;
        })
        .join('\n');
}

function getLogFilePath(date) {
    return path.join(LOG_DIR, `${date}.jsonl`);
}

router.get('/logs', (req, res) => {
    const files = safeReadDir(LOG_DIR)
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => {
            const fullPath = path.join(LOG_DIR, entry.name);
            const stats = fs.statSync(fullPath);
            return {
                date: entry.name.replace(/\.jsonl$/, ''),
                filename: entry.name,
                sizeBytes: stats.size,
                updatedAt: stats.mtime.toISOString()
            };
        })
        .sort((a, b) => b.date.localeCompare(a.date));

    res.json({
        logDir: LOG_DIR,
        count: files.length,
        files
    });
});

router.get('/logs/:date', (req, res) => {
    const { date } = req.params;
    const format = (req.query.format || 'json').toString().toLowerCase();

    if (!isValidDate(date)) {
        return res.status(400).json({ error: 'invalid date format', expected: 'YYYY-MM-DD' });
    }

    const logFile = getLogFilePath(date);
    const raw = safeReadFile(logFile);
    if (raw === null) {
        return res.status(404).json({ error: 'log file not found', date });
    }

    if (format === 'raw') {
        res.setHeader('Content-Disposition', `attachment; filename="${date}.jsonl"`);
        res.type('application/x-ndjson');
        return res.send(raw);
    }

    const entries = parseJsonLines(raw);

    if (format === 'text') {
        res.setHeader('Content-Disposition', `attachment; filename="${date}.log.txt"`);
        res.type('text/plain');
        return res.send(formatLogEntries(entries) + '\n');
    }

    return res.json({
        date,
        count: entries.length,
        entries
    });
});

router.get('/journal/:date', (req, res) => {
    const { date } = req.params;
    if (!isValidDate(date)) {
        return res.status(400).json({ error: 'invalid date format', expected: 'YYYY-MM-DD' });
    }

    const journalFile = path.join(JOURNAL_DIR, `trades-${date}.jsonl`);
    if (!fs.existsSync(journalFile)) {
        return res.status(404).json({ error: 'journal file not found', date });
    }

    return res.json(getDailySummary(date));
});

router.get('/recent', (req, res) => {
    const requested = parseInt(req.query.n, 10);
    const n = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 500)) : 50;
    const entries = getRecentLogs(n);
    res.json({
        requested: n,
        count: entries.length,
        entries
    });
});

router.get('/status', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        version: '1.3.0',
        uptime: process.uptime().toFixed(0) + 's',
        schwab: {
            authenticated: schwabService.isAuthenticated(),
            tokenStatus: schwabService.getTokenStatus(),
            session: schwabService.getSessionType()
        },
        trading: positions.getStatus(),
        storage: {
            logDir: LOG_DIR,
            journalDir: JOURNAL_DIR
        }
    });
});

router.get('/schwab', async (req, res) => {
    const t = schwabService.getAccessToken();
    if (!t) return res.json({ diagnosis: 'NO TOKEN', fix: '/auth/start' });
    const h = { Authorization: `Bearer ${t}`, Accept: 'application/json' };
    const results = {};
    log('INFO', 'Running debug checks...');

    try {
        results.userPreference = {
            status: (await axios.get('https://api.schwabapi.com/trader/v1/userPreference', { headers: h, timeout: 10000 })).status,
            ok: true
        };
    } catch (e) {
        results.userPreference = { status: e.response?.status || 'ERR', ok: false };
    }

    try {
        const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts/accountNumbers', { headers: h, timeout: 10000 });
        results.accountNumbers = { status: r.status, ok: true, data: r.data };
    } catch (e) {
        results.accountNumbers = { status: e.response?.status || 'ERR', ok: false };
    }

    try {
        results.accounts = {
            status: (await axios.get('https://api.schwabapi.com/trader/v1/accounts', { headers: h, timeout: 10000 })).status,
            ok: true
        };
    } catch (e) {
        results.accounts = { status: e.response?.status || 'ERR', ok: false };
    }

    try {
        results.marketData = {
            status: (await axios.get('https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL&fields=quote', { headers: h, timeout: 10000 })).status,
            ok: true
        };
    } catch (e) {
        results.marketData = { status: e.response?.status || 'ERR', ok: false };
    }

    let diagnosis = 'ISSUE';
    if (results.accountNumbers.ok && results.accountNumbers.data?.length > 0) {
        schwabService.setAccountHash(results.accountNumbers.data[0].hashValue);
        diagnosis = 'ALL_WORKING';
    }

    log('INFO', `Debug result: ${diagnosis}`);
    res.json({
        timestamp: new Date().toISOString(),
        version: '1.3.0',
        diagnosis,
        accountHash: schwabService.getAccountHash()?.substring(0, 10) + '...' || null,
        tokenStatus: schwabService.getTokenStatus(),
        session: schwabService.getSessionType(),
        results
    });
});

module.exports = { debugRouter: router };
