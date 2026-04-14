const test = require('node:test');
const assert = require('node:assert/strict');

function setMock(modulePath, exports) {
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports
    };
}

function loadSchwabModule() {
    const axiosPath = require.resolve('axios');
    const loggerPath = require.resolve('../src/services/logger');
    const notificationsPath = require.resolve('../src/services/notifications');
    const schwabPath = require.resolve('../src/services/schwab');

    const state = {
        axiosGetCalls: 0,
        opened: 0,
        marked: 0,
        logs: [],
        notifications: []
    };

    setMock(axiosPath, {
        create: () => ({
            interceptors: { request: { use: () => {} } },
            get: async () => ({}),
            post: async () => ({}),
            delete: async () => ({})
        }),
        get: async () => {
            state.axiosGetCalls += 1;
            return {
                data: [{
                    securitiesAccount: {
                        positions: [{
                            instrument: { symbol: 'MANUAL' },
                            longQuantity: 100,
                            averagePrice: 5.25
                        }]
                    }
                }]
            };
        },
        post: async () => ({}),
        delete: async () => ({})
    });

    setMock(loggerPath, {
        log: (level, message, data) => {
            state.logs.push({ level, message, data });
        },
        journalTrade: () => {},
        generateTradeId: () => 'T-TEST',
        setTradeId: () => {},
        getTradeId: () => null,
        clearTradeId: () => {},
        getDailySummary: () => ({}),
        getRecentLogs: () => []
    });

    setMock(notificationsPath, {
        notify: async (message, type) => {
            state.notifications.push({ message, type });
        }
    });

    delete require.cache[schwabPath];
    const { schwabService } = require('../src/services/schwab');

    return { schwabService, state };
}

test('broker orphan import is disabled by default and ignores unrelated account positions', async () => {
    process.env.ENABLE_BROKER_ORPHAN_IMPORT = 'false';
    const { schwabService, state } = loadSchwabModule();

    const pt = {
        getPosition: () => null,
        openPosition: () => { state.opened += 1; },
        markOrphan: () => { state.marked += 1; }
    };

    await schwabService.checkOrphanPositions(pt);

    assert.equal(state.axiosGetCalls, 0);
    assert.equal(state.opened, 0);
    assert.equal(state.marked, 0);
    assert.equal(state.notifications.length, 0);
});

test('orphan checker startup log reflects whether broker import is enabled', async () => {
    process.env.ENABLE_BROKER_ORPHAN_IMPORT = 'true';
    const { schwabService, state } = loadSchwabModule();
    const originalSetInterval = global.setInterval;
    global.setInterval = () => 1;

    try {
        schwabService.startOrphanCheck({});
    } finally {
        global.setInterval = originalSetInterval;
    }

    const startupLog = state.logs.find(entry => entry.message.includes('Orphan checker started'));
    assert.ok(startupLog);
    assert.match(startupLog.message, /broker import: enabled/);
});
