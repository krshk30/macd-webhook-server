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
        pendingCreated: [],
        pendingCloseCreated: [],
        pendingCleared: [],
        pendingCloseCleared: [],
        cancelCalls: [],
        sellCalls: [],
        logs: [],
        notifications: [],
        syncCalls: []
    };

    const schwabMock = {
        schwabService: {
            isAuthenticated: () => true,
            placeBuyOrder: async () => ({
                success: true,
                latency: 12,
                orderId: 'OID-1',
                session: 'NORMAL',
                orderType: 'MARKET',
                needsFillConfirmation: false
            }),
            placeSellOrder: async (...args) => {
                state.sellCalls.push(args);
                return { success: true, latency: 9 };
            },
            cancelOrder: async (...args) => {
                state.cancelCalls.push(['cancelOrder', ...args]);
                return true;
            },
            cancelOrdersForTicker: async (...args) => {
                state.cancelCalls.push(['cancelOrdersForTicker', ...args]);
                return 0;
            },
            getOrderDetails: async () => null,
            syncPendingEntries: async (...args) => {
                state.syncCalls.push(args);
                return [];
            },
            syncPendingCloses: async (...args) => {
                state.syncCalls.push(['close', ...args]);
                return [];
            },
            getSessionType: () => 'NORMAL'
        }
    };

    const positionsMock = {
        positions: {
            getPosition: () => null,
            getPendingEntry: () => null,
            hasPendingEntry: () => false,
            getAllPendingEntries: () => [],
            getPendingClose: () => null,
            hasPendingClose: () => false,
            touchPosition: () => { state.touched += 1; },
            getStopPrice: () => 0,
            isDuplicate: () => false,
            canOpenPosition: () => ({ allowed: true }),
            openPosition: () => { state.opened += 1; },
            createPendingEntry: (...args) => { state.pendingCreated.push(args); },
            createPendingClose: (...args) => { state.pendingCloseCreated.push(args); },
            clearPendingEntry: (...args) => { state.pendingCleared.push(args); },
            clearPendingClose: (...args) => { state.pendingCloseCleared.push(args); },
            isMilestoneHit: () => false,
            previewScalePosition: () => null,
            markMilestone: () => {},
            scalePosition: () => null,
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
    app.use(express.text({ type: ['text/plain', 'text/*'] }));
    app.use((req, res, next) => {
        if (req.method === 'POST' && req.path === '/webhook' && typeof req.body === 'string') {
            try {
                req.body = JSON.parse(req.body);
            } catch {
                return res.status(400).json({ error: 'invalid JSON' });
            }
        }
        next();
    });
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

test('plain-text webhook bodies that contain JSON are parsed successfully', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp();

    await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            body: '{"action":"BUY","ticker":"AAPL","token":"secret","price":100.5}'
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.action, 'BUY');
        assert.equal(state.opened, 1);
    });
});

test('limit buy requests create a pending entry instead of opening immediately', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp({
        schwabService: {
            placeBuyOrder: async () => ({
                success: true,
                latency: 15,
                orderId: 'OID-LIMIT',
                session: 'SEAMLESS',
                orderType: 'LIMIT',
                needsFillConfirmation: true
            })
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
        assert.equal(body.success, true);
        assert.equal(body.pending, true);
        assert.equal(state.opened, 0);
        assert.equal(state.pendingCreated.length, 1);
        assert.equal(state.pendingCreated[0][0], 'AAPL');
    });
});

test('scale request uses server-side order management for an existing position', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 10
    };

    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => position,
            previewScalePosition: () => ({ sharesToSell: 5, pnl: 11.5 }),
            markMilestone: () => {},
            scalePosition: () => {
                position.remainingQuantity = 5;
                return { sharesToSell: 5, pnl: 11.5 };
            },
            getStopPrice: () => 99.75
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
        assert.deepEqual(state.sellCalls[0], ['AAPL', 5, 'Scale PCT2 (50%)', 102.3]);
    });
});

test('duplicate scale milestones are ignored once already hit', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => ({ tradeId: 'T-AAPL', entryPrice: 100, remainingQuantity: 10 }),
            isMilestoneHit: () => true
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
        assert.equal(body.ignored, 'milestone_already_hit');
        assert.equal(state.sellCalls.length, 0);
    });
});

test('different scale levels are not deduped against each other', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const seen = new Set();
    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 10
    };

    const { app, state } = buildWebhookApp({
        positions: {
            isDuplicate: (ticker, action, body) => {
                const key = `${ticker}:${action}:${body?.level || ''}`;
                if (seen.has(key)) return true;
                seen.add(key);
                return false;
            },
            getPosition: () => position,
            previewScalePosition: () => ({ sharesToSell: 2, pnl: 4.6 }),
            markMilestone: () => {},
            scalePosition: () => ({ sharesToSell: 2, pnl: 4.6 }),
            getStopPrice: () => 99.75
        }
    });

    await withServer(app, async baseUrl => {
        const first = await fetch(`${baseUrl}/webhook`, {
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

        const second = await fetch(`${baseUrl}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'SCALE',
                ticker: 'AAPL',
                token: 'secret',
                price: 104.3,
                level: 'PCT4_AFTER2',
                sell_pct: 25
            })
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal((await first.json()).success, true);
        assert.equal((await second.json()).success, true);
        assert.equal(state.sellCalls.length, 2);
        assert.deepEqual(state.sellCalls[0], ['AAPL', 2, 'Scale PCT2 (50%)', 102.3]);
        assert.deepEqual(state.sellCalls[1], ['AAPL', 2, 'Scale PCT4_AFTER2 (25%)', 104.3]);
    });
});

test('close request cancels a pending entry before fill', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';
    const { app, state } = buildWebhookApp({
        positions: {
            getPendingEntry: () => ({ orderId: 'OID-PENDING' }),
            hasPendingEntry: () => true
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
                price: 100.1,
                reason: 'MACD_BEAR'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.cancelledPending, true);
        assert.deepEqual(state.cancelCalls, [
            ['cancelOrder', 'OID-PENDING'],
            ['cancelOrdersForTicker', 'AAPL']
        ]);
        assert.deepEqual(state.pendingCleared[0], ['AAPL', 'close_before_fill']);
    });
});

test('close request promotes a filled pending entry and sells it instead of clearing it', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const pending = {
        orderId: 'OID-PENDING',
        signalPrice: 100.1
    };
    const livePosition = {
        tradeId: 'T-AAPL',
        entryPrice: 100.15,
        remainingQuantity: 10,
        isClosing: false
    };
    let activated = false;

    const { app, state } = buildWebhookApp({
        schwabService: {
            getOrderDetails: async () => ({
                status: 'FILLED',
                filledQuantity: 10,
                averageFillPrice: 100.15
            })
        },
        positions: {
            getPosition: () => (activated ? livePosition : null),
            getPendingEntry: () => pending,
            activatePendingEntry: () => {
                activated = true;
                return livePosition;
            },
            closePosition: () => ({
                tradeId: 'T-AAPL',
                entryPrice: 100.15,
                pnl: -3,
                totalPnL: -3,
                holdMinutes: '1.0',
                remainingClosed: 10
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
                price: 99.85,
                reason: 'MACD_BEAR'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.sharesClosed, 10);
        assert.equal(state.pendingCleared.length, 0);
        assert.deepEqual(state.sellCalls[0], ['AAPL', 10, 'Close: MACD_BEAR', 99.85]);
    });
});

test('close request re-checks order details after cancel failure before clearing pending entry', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const pending = {
        orderId: 'OID-PENDING',
        signalPrice: 100.1
    };
    const livePosition = {
        tradeId: 'T-AAPL',
        entryPrice: 100.2,
        remainingQuantity: 8,
        isClosing: false
    };
    let activated = false;
    let detailCallCount = 0;

    const { app, state } = buildWebhookApp({
        schwabService: {
            cancelOrder: async (...args) => {
                state.cancelCalls.push(['cancelOrder', ...args]);
                return false;
            },
            getOrderDetails: async () => {
                detailCallCount += 1;
                if (detailCallCount === 1) return null;
                return {
                    status: 'FILLED',
                    filledQuantity: 8,
                    averageFillPrice: 100.2
                };
            }
        },
        positions: {
            getPosition: () => (activated ? livePosition : null),
            getPendingEntry: () => pending,
            activatePendingEntry: () => {
                activated = true;
                return livePosition;
            },
            closePosition: () => ({
                tradeId: 'T-AAPL',
                entryPrice: 100.2,
                pnl: -4,
                totalPnL: -4,
                holdMinutes: '1.0',
                remainingClosed: 8
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
                price: 99.7,
                reason: 'MACD_BEAR'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(state.pendingCleared.length, 0);
        assert.deepEqual(state.sellCalls[0], ['AAPL', 8, 'Close: MACD_BEAR', 99.7]);
    });
});

test('close request uses sell and notification flow for an open position', async () => {
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
        assert.deepEqual(state.cancelCalls, [['cancelOrdersForTicker', 'AAPL']]);
        assert.deepEqual(state.sellCalls[0], ['AAPL', 6, 'Close: MACD_BEAR', 102.5]);
        assert.equal(state.notifications.length, 1);
        assert.match(state.notifications[0].message, /CLOSED AAPL/);
    });
});

test('close request keeps the position open locally when the close order still needs fill confirmation', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 6,
        isClosing: false
    };

    const { app, state } = buildWebhookApp({
        schwabService: {
            placeSellOrder: async (...args) => {
                state.sellCalls.push(args);
                return {
                    success: true,
                    latency: 9,
                    orderId: 'OID-CLOSE-1',
                    orderType: 'LIMIT',
                    session: 'SEAMLESS',
                    needsFillConfirmation: true
                };
            }
        },
        positions: {
            getPosition: () => position
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
                price: 99.4,
                reason: 'MACD_BEAR'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.pending, true);
        assert.equal(body.orderId, 'OID-CLOSE-1');
        assert.equal(state.pendingCloseCreated.length, 1);
        assert.equal(state.pendingCloseCreated[0][0], 'AAPL');
        assert.equal(state.notifications.length, 1);
        assert.match(state.notifications[0].message, /CLOSE PENDING AAPL/);
    });
});

test('close request is ignored when a close is already in progress', async () => {
    process.env.WEBHOOK_TOKEN = 'secret';

    const position = {
        tradeId: 'T-AAPL',
        entryPrice: 100,
        remainingQuantity: 6,
        isClosing: true
    };

    const { app, state } = buildWebhookApp({
        positions: {
            getPosition: () => position
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
                price: 99.4,
                reason: 'STOCHK_TIER1_20'
            })
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.pending, true);
        assert.equal(body.note, 'close already in progress');
        assert.equal(state.sellCalls.length, 0);
        assert.equal(state.notifications.length, 0);
    });
});
