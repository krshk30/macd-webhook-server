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
