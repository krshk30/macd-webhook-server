const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadPositionsModule() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macd-positions-'));
    process.env.DATA_DIR = path.join(tmpRoot, 'data');
    process.env.LOG_DIR = path.join(tmpRoot, 'logs');
    process.env.ENABLE_FILE_LOG = 'false';
    process.env.MAX_POSITIONS = '3';
    process.env.MAX_DAILY_LOSS = '-500';
    process.env.TRADING_START_HOUR = '0';
    process.env.TRADING_END_HOUR = '24';
    process.env.DEDUP_WINDOW_MS = '5000';

    const positionsPath = require.resolve('../src/services/positions');
    const loggerPath = require.resolve('../src/services/logger');
    delete require.cache[positionsPath];
    delete require.cache[loggerPath];

    return require('../src/services/positions').positions;
}

test('positions service opens, scales, and closes a trade correctly', () => {
    const positions = loadPositionsModule();

    const allowed = positions.canOpenPosition('AAPL');
    assert.equal(allowed.allowed, true);

    positions.openPosition('AAPL', 100, 10, {
        path: 'P1_CROSS',
        score: 5,
        stochK: 42.5,
        macd: 0.12
    });

    let position = positions.getPosition('AAPL');
    assert.ok(position);
    assert.equal(position.remainingQuantity, 10);
    assert.equal(position.entryData.path, 'P1_CROSS');

    const scale = positions.scalePosition('AAPL', 50, 'PCT2', 102);
    assert.ok(scale);
    assert.equal(scale.sharesToSell, 5);
    assert.equal(Number(scale.pnl.toFixed(2)), 10);

    position = positions.getPosition('AAPL');
    assert.ok(position);
    assert.equal(position.remainingQuantity, 5);
    assert.equal(position.scaledExits.length, 1);

    const summary = positions.closePosition('AAPL', 103, 'MACD_BEAR');
    assert.ok(summary);
    assert.equal(summary.remainingClosed, 5);
    assert.equal(Number(summary.pnl.toFixed(2)), 15);
    assert.equal(Number(summary.totalPnL.toFixed(2)), 25);
    assert.equal(positions.getPosition('AAPL'), null);
});

test('duplicate detection filters repeated alerts inside the configured window', () => {
    const positions = loadPositionsModule();

    assert.equal(positions.isDuplicate('MSFT', 'BUY'), false);
    assert.equal(positions.isDuplicate('MSFT', 'BUY'), true);
    assert.equal(positions.isDuplicate('MSFT', 'SCALE'), false);
});

test('duplicate detection distinguishes scale levels and close reasons', () => {
    const positions = loadPositionsModule();

    assert.equal(positions.isDuplicate('MSFT', 'SCALE', { level: 'PCT2' }), false);
    assert.equal(positions.isDuplicate('MSFT', 'SCALE', { level: 'FAST4' }), false);
    assert.equal(positions.isDuplicate('MSFT', 'SCALE', { level: 'PCT2' }), true);

    assert.equal(positions.isDuplicate('MSFT', 'CLOSE', { reason: 'MACD_BEAR' }), false);
    assert.equal(positions.isDuplicate('MSFT', 'CLOSE', { reason: 'FLOOR_BREACH' }), false);
    assert.equal(positions.isDuplicate('MSFT', 'CLOSE', { reason: 'MACD_BEAR' }), true);
});

test('pending entries block duplicate buys and can be activated on fill', () => {
    const positions = loadPositionsModule();

    positions.createPendingEntry('AAPL', 100.5, 10, 'OID-1', {
        path: 'P2_VWAP',
        score: 8
    }, {
        session: 'SEAMLESS',
        orderType: 'LIMIT'
    });

    const blocked = positions.canOpenPosition('AAPL');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'Pending entry for AAPL');

    const pending = positions.getPendingEntry('AAPL');
    assert.ok(pending);
    assert.equal(pending.orderId, 'OID-1');

    const activated = positions.activatePendingEntry('AAPL', 100.6, 10, { source: 'test' });
    assert.ok(activated);
    assert.equal(activated.tradeId, pending.tradeId);
    assert.equal(positions.getPendingEntry('AAPL'), null);

    const live = positions.getPosition('AAPL');
    assert.ok(live);
    assert.equal(live.remainingQuantity, 10);
    assert.equal(live.currentStopPrice, 99.59);
});

test('preview scale does not mutate state before an order is confirmed', () => {
    const positions = loadPositionsModule();
    positions.openPosition('AAPL', 100, 10, {});

    const preview = positions.previewScalePosition('AAPL', 50, 102);
    assert.deepEqual(preview, { sharesToSell: 5, pnl: 10 });

    const before = positions.getPosition('AAPL');
    assert.equal(before.remainingQuantity, 10);

    positions.markMilestone('AAPL', 'PCT2');
    assert.equal(positions.isMilestoneHit('AAPL', 'PCT2'), true);
    assert.equal(positions.isMilestoneHit('AAPL', 'FAST4'), false);
});

test('initial hard stop uses 2% for cheap stocks and 1% above $2.50', () => {
    const positions = loadPositionsModule();

    positions.openPosition('CHEAP', 1.3667, 10, {});
    positions.openPosition('MID', 6.9153, 10, {});

    const cheap = positions.getPosition('CHEAP');
    const mid = positions.getPosition('MID');

    assert.ok(cheap);
    assert.ok(mid);
    assert.equal(cheap.currentStopPrice, 1.34);
    assert.equal(mid.currentStopPrice, 6.85);
});

test('pending close state is created and cleared around an open position', () => {
    const positions = loadPositionsModule();

    positions.openPosition('AAPL', 100, 10, {});
    const pendingClose = positions.createPendingClose('AAPL', 99.5, 10, 'OID-CLOSE-1', 'MACD_BEAR', {
        session: 'SEAMLESS',
        orderType: 'LIMIT'
    });

    assert.ok(pendingClose);
    assert.equal(positions.hasPendingClose('AAPL'), true);
    assert.equal(positions.getPendingClose('AAPL').orderId, 'OID-CLOSE-1');
    assert.equal(positions.getPosition('AAPL').isClosing, true);

    positions.updatePendingClose('AAPL', { processedFilledQuantity: 4 });
    assert.equal(positions.getPendingClose('AAPL').processedFilledQuantity, 4);

    positions.clearPendingClose('AAPL', 'test_clear');
    assert.equal(positions.hasPendingClose('AAPL'), false);
    assert.equal(positions.getPosition('AAPL').isClosing, false);
});
