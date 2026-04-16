const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

function setMock(modulePath, exports) {
    require.cache[require.resolve(modulePath)] = {
        id: require.resolve(modulePath),
        filename: require.resolve(modulePath),
        loaded: true,
        exports
    };
}

function buildDebugApp() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macd-debug-'));
    const logDir = path.join(tmpRoot, 'logs');
    const journalDir = path.join(logDir, 'journal');
    fs.mkdirSync(journalDir, { recursive: true });

    fs.writeFileSync(
        path.join(logDir, '2026-04-16.jsonl'),
        [
            JSON.stringify({ ts: '2026-04-16T13:30:00.000Z', level: 'INFO', message: 'Server started', port: 3000 }),
            JSON.stringify({ ts: '2026-04-16T13:31:00.000Z', level: 'WEBHOOK', message: 'Received BUY', ticker: 'AAPL' })
        ].join('\n') + '\n'
    );

    fs.writeFileSync(
        path.join(journalDir, 'trades-2026-04-16.jsonl'),
        JSON.stringify({ ts: '2026-04-16T13:31:00.000Z', action: 'BUY', ticker: 'AAPL' }) + '\n'
    );

    process.env.LOG_DIR = logDir;

    setMock('../src/services/schwab', {
        schwabService: {
            isAuthenticated: () => true,
            getTokenStatus: () => 'valid (30m)',
            getSessionType: () => 'NORMAL',
            getAccessToken: () => null,
            getAccountHash: () => null,
            setAccountHash: () => {}
        }
    });

    setMock('../src/services/positions', {
        positions: {
            getStatus: () => ({
                openPositions: [],
                pendingEntries: [],
                pendingCloses: [],
                dailyPnL: '12.34',
                dailyTradeCount: 2
            })
        }
    });

    setMock('../src/services/logger', {
        log: () => {},
        getDailySummary: date => ({ date, totalTrades: 1, trades: [] }),
        getRecentLogs: n => Array.from({ length: Math.min(n, 2) }, (_, i) => ({ ts: `2026-04-16T13:3${i}:00.000Z`, message: `entry-${i}` }))
    });

    delete require.cache[require.resolve('../src/routes/debug')];
    const { debugRouter } = require('../src/routes/debug');

    const app = express();
    app.use('/debug', debugRouter);
    return { app, logDir };
}

async function withServer(app, fn) {
    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s));
    });

    try {
        const { port } = server.address();
        return await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('debug logs endpoints list files and return parsed entries', async () => {
    const { app, logDir } = buildDebugApp();

    await withServer(app, async baseUrl => {
        const listResponse = await fetch(`${baseUrl}/debug/logs`);
        assert.equal(listResponse.status, 200);
        const listBody = await listResponse.json();
        assert.equal(listBody.logDir, logDir);
        assert.equal(listBody.count, 1);
        assert.equal(listBody.files[0].date, '2026-04-16');

        const dayResponse = await fetch(`${baseUrl}/debug/logs/2026-04-16`);
        assert.equal(dayResponse.status, 200);
        const dayBody = await dayResponse.json();
        assert.equal(dayBody.count, 2);
        assert.equal(dayBody.entries[1].ticker, 'AAPL');
    });
});

test('debug logs text, journal, recent, and status endpoints work', async () => {
    const { app } = buildDebugApp();

    await withServer(app, async baseUrl => {
        const textResponse = await fetch(`${baseUrl}/debug/logs/2026-04-16?format=text`);
        assert.equal(textResponse.status, 200);
        const textBody = await textResponse.text();
        assert.match(textBody, /\[2026-04-16T13:30:00.000Z\] \[INFO\] Server started/);

        const journalResponse = await fetch(`${baseUrl}/debug/journal/2026-04-16`);
        assert.equal(journalResponse.status, 200);
        const journalBody = await journalResponse.json();
        assert.equal(journalBody.date, '2026-04-16');

        const recentResponse = await fetch(`${baseUrl}/debug/recent?n=100`);
        assert.equal(recentResponse.status, 200);
        const recentBody = await recentResponse.json();
        assert.equal(recentBody.requested, 100);
        assert.equal(recentBody.count, 2);

        const statusResponse = await fetch(`${baseUrl}/debug/status`);
        assert.equal(statusResponse.status, 200);
        const statusBody = await statusResponse.json();
        assert.equal(statusBody.schwab.authenticated, true);
        assert.equal(statusBody.trading.dailyPnL, '12.34');
    });
});
