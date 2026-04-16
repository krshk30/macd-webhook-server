const test = require('node:test');
const assert = require('node:assert/strict');

const { schwabService } = require('../src/services/schwab');

test('sticky floor keeps the ratcheted stop on pullbacks', () => {
    process.env.FLOOR_AT_1PCT = '0';
    process.env.FLOOR_AT_2PCT = '0.5';
    process.env.FLOOR_AT_3PCT = '1.5';
    process.env.FLOOR_AT_4PCT = '2.5';
    process.env.FLOOR_TRAIL_GAP = '1.5';

    const floorState = schwabService.__test.getActiveFloorState(
        {
            entryPrice: 1.9797,
            currentStopPrice: 2.04
        },
        2.04
    );

    assert.equal(floorState.floorPct, 0.5);
    assert.equal(floorState.computedFloorPrice, 1.99);
    assert.equal(floorState.activeFloorPrice, 2.04);
});

test('active floor advances when the newly computed floor is higher than the stored stop', () => {
    process.env.FLOOR_AT_1PCT = '0';
    process.env.FLOOR_AT_2PCT = '0.5';
    process.env.FLOOR_AT_3PCT = '1.5';
    process.env.FLOOR_AT_4PCT = '2.5';
    process.env.FLOOR_TRAIL_GAP = '1.5';

    const floorState = schwabService.__test.getActiveFloorState(
        {
            entryPrice: 1.9797,
            currentStopPrice: 1.99
        },
        4.56
    );

    assert.equal(floorState.floorPct.toFixed(2), '3.06');
    assert.equal(floorState.computedFloorPrice, 2.04);
    assert.equal(floorState.activeFloorPrice, 2.04);
});

test('floor trigger uses last price during regular hours but preserves bid fallback otherwise', () => {
    const originalToLocaleString = Date.prototype.toLocaleString;

    try {
        Date.prototype.toLocaleString = function mockedToLocaleString() {
            return '4/16/2026, 10:34:00 AM';
        };

        assert.equal(
            schwabService.__test.selectFloorTriggerPrice({ bidPrice: 1.83, lastPrice: 1.89 }),
            1.89
        );

        Date.prototype.toLocaleString = function mockedToLocaleStringExtended() {
            return '4/16/2026, 8:34:00 AM';
        };

        assert.equal(
            schwabService.__test.selectFloorTriggerPrice({ bidPrice: 1.83, lastPrice: 1.89 }),
            1.83
        );
    } finally {
        Date.prototype.toLocaleString = originalToLocaleString;
    }
});

test('hard stop trigger uses last price during regular hours but preserves bid fallback otherwise', () => {
    const originalToLocaleString = Date.prototype.toLocaleString;

    try {
        Date.prototype.toLocaleString = function mockedToLocaleString() {
            return '4/16/2026, 10:34:00 AM';
        };

        assert.equal(
            schwabService.__test.selectHardStopTriggerPrice({ bidPrice: 1.33, lastPrice: 1.34 }),
            1.34
        );

        Date.prototype.toLocaleString = function mockedToLocaleStringExtended() {
            return '4/16/2026, 8:34:00 AM';
        };

        assert.equal(
            schwabService.__test.selectHardStopTriggerPrice({ bidPrice: 1.33, lastPrice: 1.34 }),
            1.33
        );
    } finally {
        Date.prototype.toLocaleString = originalToLocaleString;
    }
});
