const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pinePath = path.join(__dirname, '..', 'tradingview', 'macd-momentum-alerts-v3.4.2_1.pine');
const pineSource = fs.readFileSync(pinePath, 'utf8');

function expectAlertContains(action, snippets) {
    const actionMarker = `"action":"${action}"`;
    const start = pineSource.indexOf(actionMarker);
    assert.notEqual(start, -1, `missing ${action} alert`);

    const window = pineSource.slice(Math.max(0, start - 200), start + 1200);
    for (const snippet of snippets) {
        assert.match(window, new RegExp(snippet), `${action} alert missing ${snippet}`);
    }
}

test('pine script contains all webhook action types used by the server', () => {
    for (const action of ['BUY', 'SCALE', 'CLOSE', 'HEARTBEAT']) {
        assert.match(pineSource, new RegExp(`"action":"${action}"`));
    }
});

test('buy alert carries the key fields the server stores for post-trade analysis', () => {
    expectAlertContains('BUY', [
        '"path":"',
        '"ticker":"',
        '"price":',
        '"volume":',
        '"stochK":',
        '"macd":',
        '"hist":',
        '"ema9":',
        '"ema20":',
        '"vwap":',
        '"score":',
        '"token":"'
    ]);
});

test('heartbeat alert carries floor data used by server-side protection logic', () => {
    expectAlertContains('HEARTBEAT', [
        '"profitPct":',
        '"floorPct":',
        '"floorPrice":',
        '"maxProfitPct":',
        '"tier":',
        '"token":"'
    ]);
});
