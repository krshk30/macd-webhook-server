const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function setMock(modulePath, exports) {
    require.cache[require.resolve(modulePath)] = {
        id: require.resolve(modulePath),
        filename: require.resolve(modulePath),
        loaded: true,
        exports
    };
}

function buildWebhookApp(overrides = {}) {
    const state = {
        touched: 0,
        opened: 0,
        stopUpdates: [],
        cancelCalls: [],
        sellWithStopCalls: [],
        sellCalls: [],
        logs: [],
        notifications: []
    };

    const schwabMock = {
        schwabService: {
            isAuthenticated: () => true,
            placeBuyOrder: async () => ({ success: true, latency: 12, orderId: 'OID-1', stopPrice: 99.98 }),
            placeSellOrder: async (...args) => {
                state.sellCalls.push(args);
                return { success: true, latency: 9 };
            },
            placeSellWithStop: async (...args) => {
                state.sellWithStopCalls.push(args);
                return { success: true, latency: 10 };
            },
            placeStopOrder: async () => ({ success: true, latency: 11, orderId: 'STOP-1' }),
            cancelOrder: async (...args) => {
                state.cancelCalls.push(['cancelOrder', ...args]);
                return true;
            },
            cancelOrdersForTicker: async (...args) => {
                state.cancelCalls.push(['cancelOrdersForTicker', ...args]);
                return 0;
            },
            getSessionType: () => 'NORMAL'
        }
    };

    const positionsMock = {
        positions: {
            getPosition: () => null,
            touchPosition: () => { state.touched += 1; },
            getStopPrice: () => 0,
            isDuplicate: () => false,
            canOpenPosition: () => ({ allowed: true }),
            openPosition: () => { state.opened += 1; },
            setStopOrder: () => {},
            getStopOrderId: () => null,
            markMilestone: () => {},
            scalePosition: () => null,
            updateStopPrice: (...args) => { state.stopUpdates.push(args); },
            closePosition: () => ({
                tradeId: 'T-1',
                entryPrice: 100,
                pnl: 0,
                totalPnL: 0,
                holdMinutes: '0.0',
                remainingClosed: 0
            })
        }
    };

    const notificationsMock = {
        notify: async (message, type) => {
            state.notifications.push({ message, type });
        }
    };

    const loggerMock = {
        log: (level, message, data) => {
            state.logs.push({ level, message, data });
        },
        getTradeId: ticker => `T-${ticker}`
    };

    const mergedSchwab = {
        schwabService: { ...schwabMock.schwabService, ...(overrides.schwabService || {}) }
    };
    const mergedPositions = {
        positions: { ...positionsMock.positions, ...(overrides.positions || {}) }
    };

    setMock('../src/services/schwab', mergedSchwab);
    setMock('../src/services/positions', mergedPositions);
    setMock('../src/services/notifications', overrides.notifications || notificationsMock);
    setMock('../src/services/logger', overrides.logger || loggerMock);

    delete require.cache[require.resolve('../src/routes/webhook')];
    const { webhookRouter } = require('../src/routes/webhook');

    const app = express();
    app.use(express.json());
    app.use(webhookRouter);

    return { app, state };
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

test('webhook rejects invalid token', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app } = buildWebhookApp();

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'BUY', ticker: 'AAPL', token: 'wrong' })
        });

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'unauthorized' });
    });
});

test('webhook rejects requests while Schwab auth is unavailable', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app } = buildWebhookApp({
        schwabService: {
            isAuthenticated: () => false
        }
    });

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'BUY', ticker: 'AAPL', token: 'secret' })
        });

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'not_authenticated' });
    });
});

test('heartbeat returns tracked position state and touches the position', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => ({ tradeId: 'T-AAPL', remainingQuantity: 7 }),
            getStopPrice: () => 101.25
        }
    });

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'HEARTBEAT',
                ticker: 'AAPL',
                token: 'secret',
                tier: 2,
                profitPct: 1.8
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'heartbeat_ok');
        assert.equal(body.tradeId, 'T-AAPL');
        assert.equal(body.remaining, 7);
        assert.equal(body.currentStop, 101.25);
        assert.equal(state.touched, 1);
    });
});

test('buy request returns a rejection payload when position guards block entry', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp({
        positions: {
            canOpenPosition: () => ({ allowed: false, reason: 'Daily loss limit' })
        }
    });

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'BUY',
                ticker: 'AAPL',
                token: 'secret',
                price: 100.5
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, false);
        assert.equal(body.rejected, 'Daily loss limit');
        assert.equal(state.opened, 0);
    });
});

test('scale request uses server-side order management for an existing position', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    process.env.STOP_LOSS_CENTS = '0.02';

    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 10
    };

    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => position,
            getStopOrderId: () => 'STOP-OLD',
            getStopPrice: () => 99.75,
            markMilestone: () => {},
            scalePosition: () => {
                position.remainingQuantity = 5;
                return { sharesToSell: 5, pnl: 11.5 };
            }
        }
    });

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'SCALE',
                ticker: 'AAPL',
                token: 'secret',
                price: 102.3,
                level: 'PCT2',
                sell_pct: 50
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.action, 'SCALE');
        assert.equal(body.sharesSold, 5);
        assert.equal(body.remaining, 5);
        assert.equal(body.currentStop, 99.75);
        assert.equal(state.sellWithStopCalls.length, 1);
        assert.deepEqual(state.sellWithStopCalls[0], ['AAPL', 5, 5, 'Scale PCT2 (50%)', 102.3, 99.75]);
        assert.deepEqual(state.stopUpdates[0], ['AAPL', 99.75, null]);
        assert.deepEqual(state.cancelCalls, [
            ['cancelOrder', 'STOP-OLD'],
            ['cancelOrdersForTicker', 'AAPL']
        ]);
    });
});

test('close request uses server-side stop cancellation, sell, and notification flow', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 6,
        isClosing: false
    };

    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => position,
            getStopOrderId: () => 'STOP-1',
            closePosition: () => ({
                tradeId: 'T-AAPL',
                entryPrice: 100,
                pnl: 15,
                totalPnL: 28,
                holdMinutes: '3.5',
                remainingClosed: 6
            })
        }
    });

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'CLOSE',
                ticker: 'AAPL',
                token: 'secret',
                price: 102.5,
                reason: 'MACD_BEAR'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.action, 'CLOSE');
        assert.equal(body.reason, 'MACD_BEAR');
        assert.equal(body.sharesClosed, 6);
        assert.equal(body.totalPnL, '28.00');
        assert.equal(position.isClosing, true);
        assert.deepEqual(state.cancelCalls, [
            ['cancelOrder', 'STOP-1'],
            ['cancelOrdersForTicker', 'AAPL']
        ]);
        assert.deepEqual(state.sellCalls[0], ['AAPL', 6, 'Close: MACD_BEAR', 102.5]);
        assert.equal(state.notifications.length, 1);
        assert.match(state.notifications[0].message, /CLOSED AAPL/);
    });
});
