/**
 * Schwab Trader API Service v1.3.0
 * 
 * Changes from v1.2.9:
 *   - journalTrade for heartbeat expired events
 *   - Trade ID in heartbeat/orphan notifications
 *   - Structured log data objects
 */
const axios = require('axios');
const { log, journalTrade } = require('./logger');
const { notify } = require('./notifications');

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';
const SCHWAB_MARKETDATA_BASE = 'https://api.schwabapi.com/marketdata/v1';

const https = require('https');
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

let tokens = { access_token: null, refresh_token: null, expires_at: 0 };
let accountHash = null, refreshTimer = null, orphanCheckTimer = null, heartbeatTimer = null, pendingEntryTimer = null;

const api = axios.create({
    baseURL: SCHWAB_API_BASE,
    httpsAgent: keepAliveAgent,
    timeout: 5000,
    headers: { 'Content-Type': 'application/json' }
});
api.interceptors.request.use(c => {
    if (tokens.access_token) c.headers.Authorization = `Bearer ${tokens.access_token}`;
    return c;
});

function getEasternTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function isRegularHours() { const et = getEasternTime(); const m = et.getHours() * 60 + et.getMinutes(); return m >= 570 && m < 960; }
function getSessionType() { return isRegularHours() ? 'NORMAL' : 'SEAMLESS'; }
function getLimitBuffer() { return parseFloat(process.env.LIMIT_BUFFER_CENTS || '0.01'); }
function getFloorCheckIntervalSecs() { return parseInt(process.env.FLOOR_CHECK_INTERVAL_SECS || '5'); }
function getPendingEntryCheckIntervalSecs() { return parseInt(process.env.PENDING_ENTRY_CHECK_INTERVAL_SECS || '2'); }
function getPendingEntryTimeoutSecs() { return parseInt(process.env.PENDING_ENTRY_TIMEOUT_SECS || '120'); }
function isServerManagedScalesEnabled() { return process.env.SERVER_MANAGED_SCALES !== 'false'; }
function isBrokerOrphanImportEnabled() { return process.env.ENABLE_BROKER_ORPHAN_IMPORT === 'true'; }
function getOrderType(req, price) {
    if (isRegularHours()) return req;
    if (req === 'MARKET' && price > 0) { log('ORDER', 'Ext hours: MARKET → LIMIT'); return 'LIMIT'; }
    return req;
}
function getScaleConfig() {
    return {
        fast4Thresh: parseFloat(process.env.SCALE_FAST4_THRESHOLD || '4'),
        fast4SellPct: parseInt(process.env.SCALE_FAST4_SELL_PCT || '75'),
        pct2Thresh: parseFloat(process.env.SCALE_PCT2_THRESHOLD || '2'),
        pct2SellPct: parseInt(process.env.SCALE_PCT2_SELL_PCT || '50'),
        pct4After2Thresh: parseFloat(process.env.SCALE_PCT4_AFTER2_THRESHOLD || '4'),
        pct4After2SellPct: parseInt(process.env.SCALE_PCT4_AFTER2_SELL_PCT || '25')
    };
}

function getAuthUrl() {
    return `${SCHWAB_AUTH_URL}?response_type=code&client_id=${process.env.SCHWAB_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SCHWAB_CALLBACK_URL)}`;
}

async function exchangeCodeForTokens(code) {
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL,
            new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.SCHWAB_CALLBACK_URL }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent }
        );
        tokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + (r.data.expires_in * 1000) };
        log('INFO', 'OAuth tokens obtained');
        startTokenRefresh();
        return true;
    } catch (e) {
        log('ERROR', 'Token exchange failed', { error: e.response?.data?.error || e.message });
        return false;
    }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) return false;
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL,
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent }
        );
        tokens.access_token = r.data.access_token;
        tokens.expires_at = Date.now() + (r.data.expires_in * 1000);
        if (r.data.refresh_token) tokens.refresh_token = r.data.refresh_token;
        log('INFO', `Token refreshed`, { expiresIn: r.data.expires_in });
        return true;
    } catch (e) {
        log('ERROR', 'Token refresh failed', { error: e.message });
        await notify('TOKEN REFRESH FAILED', 'error');
        return false;
    }
}

function startTokenRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
        log('INFO', 'Token refresh cycle...');
        await refreshAccessToken();
    }, 25 * 60 * 1000);
    log('INFO', 'Token refresh started (25 min)');
}

function isAuthenticated() { return tokens.access_token && Date.now() < tokens.expires_at; }
function getTokenStatus() {
    if (!tokens.access_token) return 'no_token';
    if (Date.now() >= tokens.expires_at) return 'expired';
    return `valid (${Math.round((tokens.expires_at - Date.now()) / 60000)}m)`;
}
function getAccessToken() { return tokens.access_token; }
function setAccountHash(h) { accountHash = h; log('INFO', `Hash stored: ${h.substring(0,10)}...`); }
function getAccountHash() { return accountHash; }

async function fetchAccountHash() {
    if (!tokens.access_token) return null;
    for (let i = 1; i <= 2; i++) {
        try {
            const r = await api.get('/accounts/accountNumbers');
            if (r.data?.length > 0) {
                accountHash = r.data[0].hashValue;
                log('INFO', `Hash fetched: ${r.data[0].accountNumber} → ${accountHash.substring(0,10)}...`);
                return accountHash;
            }
        } catch (e) {
            log('WARN', `Hash attempt ${i} failed`, { status: e.response?.status });
            if (i < 2) await new Promise(r => setTimeout(r, 3000));
        }
    }
    log('ERROR', 'Hash failed — visit /debug/schwab');
    return null;
}

function getAccountId() { return accountHash || process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID; }

async function getPositionsFromSchwab() {
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
            params: { fields: 'positions' },
            httpsAgent: keepAliveAgent, timeout: 10000
        });
        const acct = (r.data || []).find(a => a.securitiesAccount) || r.data?.[0] || {};
        return acct?.securitiesAccount?.positions || [];
    } catch (e) {
        log('DEBUG', `Positions fetch: ${e.response?.status || e.message}`);
        return [];
    }
}

function findBrokerPosition(positions, ticker) {
    return (positions || []).find(p => p.instrument?.symbol === ticker && (p.longQuantity || 0) > 0) || null;
}

async function getCurrentPrice(ticker) {
    const prices = await getCurrentPrices([ticker]);
    return prices[ticker] || 0;
}

async function getCurrentPrices(tickers) {
    const uniqueTickers = Array.from(new Set((tickers || []).filter(Boolean)));
    if (uniqueTickers.length === 0) return {};

    try {
        const r = await axios.get(`${SCHWAB_MARKETDATA_BASE}/quotes`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
            params: { symbols: uniqueTickers.join(','), fields: 'quote' },
            httpsAgent: keepAliveAgent, timeout: 5000
        });

        const prices = {};
        for (const ticker of uniqueTickers) {
            const quote = r.data?.[ticker]?.quote || {};
            const bidPrice = quote.bidPrice || 0;
            const lastPrice = quote.lastPrice || 0;
            const price = bidPrice > 0 ? bidPrice : lastPrice;
            prices[ticker] = price;
            log('INFO', `Current price ${ticker}`, { bid: bidPrice, last: lastPrice, using: price });
        }

        return prices;
    } catch (e) {
        log('WARN', 'Batch price fetch failed', {
            tickers: uniqueTickers,
            error: e.response?.status || e.message
        });

        const prices = {};
        for (const ticker of uniqueTickers) prices[ticker] = 0;
        return prices;
    }
}

// v1.3.0: Get actual fill price from a completed order
async function getOrderFillPrice(orderId) {
    if (!orderId) return 0;
    try {
        const r = await api.get(`/accounts/${getAccountId()}/orders/${orderId}`);
        const order = r.data;
        // Check order activities for fill price
        const activities = order?.orderActivityCollection || [];
        for (const act of activities) {
            const legs = act?.executionLegs || [];
            for (const leg of legs) {
                if (leg.price > 0) {
                    log('INFO', `Order ${orderId} fill price: $${leg.price}`, {
                        quantity: leg.quantity
                    });
                    return leg.price;
                }
            }
        }
        // Fallback: check if price field exists on order
        if (order?.price > 0) return order.price;
        return 0;
    } catch (e) {
        log('WARN', `Could not get fill price for order ${orderId}`, {
            error: e.response?.status || e.message
        });
        return 0;
    }
}

// v1.3.0: BUY + STOP in one TRIGGER order
// Schwab activates the child STOP automatically after BUY fills
async function placeBuyOrder(ticker, quantity, price) {
    const t0 = Date.now(), session = getSessionType();
    const buyOrderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();
    const stopCents = parseFloat(process.env.STOP_LOSS_CENTS || '0.02');
    const stopPrice = parseFloat((price - stopCents).toFixed(2));

    // Child STOP order — activates after BUY fills
    const childStop = {
        orderStrategyType: 'SINGLE',
        orderType: 'STOP',
        stopPrice: stopPrice,
        session,
        duration: 'DAY',
        orderLegCollection: [{
            instruction: 'SELL', quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    // Extended hours: child stop must be STOP_LIMIT
    if (!isRegularHours()) {
        childStop.orderType = 'STOP_LIMIT';
        childStop.price = parseFloat((stopPrice - buffer).toFixed(2));
    }

    // Parent TRIGGER order
    const order = {
        orderStrategyType: 'TRIGGER',
        orderType: buyOrderType,
        session,
        duration: 'DAY',
        orderLegCollection: [{
            instruction: 'BUY', quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }],
        childOrderStrategies: [childStop]
    };

    // BUY LIMIT for extended hours
    if (buyOrderType === 'LIMIT' && price > 0) {
        order.price = parseFloat((price + buffer).toFixed(2));
    }

    log('ORDER', `BUY+STOP ${quantity} ${ticker}`, {
        buyType: buyOrderType, stopPrice, session, signalPrice: price
    });

    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const lat = Date.now() - t0, oid = r.headers.location?.split('/').pop();
        log('ORDER', `BUY+STOP placed ${quantity} ${ticker}`, {
            orderId: oid, stopPrice, session, latency: lat
        });
        await notify(`BUY ${quantity} ${ticker} + STOP $${stopPrice} | ${buyOrderType} ${session} | ${lat}ms`, 'buy');
        return { success: true, orderId: oid, latency: lat, stopPrice };
    } catch (e) {
        log('ERROR', `BUY+STOP failed: ${ticker}`, {
            error: e.response?.data?.message || e.message,
            statusCode: e.response?.status
        });
        return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 };
    }
}

// v1.3.0: SELL + child STOP in one TRIGGER order (for SCALE exits)
// Sells partial shares, child STOP for remaining activates after sell fills
async function placeSellWithStop(ticker, sellQty, remainingQty, reason, price, stopPrice) {
    const t0 = Date.now(), session = getSessionType();
    const sellOrderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();

    // Child STOP for remaining shares
    const childStop = {
        orderStrategyType: 'SINGLE',
        orderType: 'STOP',
        stopPrice: parseFloat(stopPrice.toFixed(2)),
        session,
        duration: 'DAY',
        orderLegCollection: [{
            instruction: 'SELL', quantity: remainingQty,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    // Extended hours: STOP_LIMIT
    if (!isRegularHours()) {
        childStop.orderType = 'STOP_LIMIT';
        childStop.price = parseFloat((stopPrice - buffer).toFixed(2));
    }

    // Parent TRIGGER: SELL (scale) → child STOP (remaining)
    const order = {
        orderStrategyType: 'TRIGGER',
        orderType: sellOrderType,
        session,
        duration: 'DAY',
        orderLegCollection: [{
            instruction: 'SELL', quantity: sellQty,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }],
        childOrderStrategies: [childStop]
    };

    // SELL LIMIT for extended hours
    if (sellOrderType === 'LIMIT' && price > 0) {
        order.price = parseFloat((price - buffer).toFixed(2));
    }

    log('ORDER', `SELL+STOP ${sellQty} ${ticker} (${reason})`, {
        sellType: sellOrderType, remaining: remainingQty,
        stopPrice: stopPrice.toFixed(2), session
    });

    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const lat = Date.now() - t0;
        log('ORDER', `SELL+STOP placed ${sellQty} ${ticker} (${reason})`, {
            remaining: remainingQty, stopPrice: stopPrice.toFixed(2), latency: lat
        });
        await notify(`SELL ${sellQty} ${ticker} (${reason}) + STOP ${remainingQty} @ $${stopPrice.toFixed(2)} | ${lat}ms`, 'sell');
        return { success: true, latency: lat };
    } catch (e) {
        log('ERROR', `SELL+STOP failed: ${ticker}`, {
            error: e.response?.data?.message || e.message, reason
        });
        return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 };
    }
}

async function placeSellOrder(ticker, quantity, reason, price) {
    const t0 = Date.now(), session = getSessionType(), orderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();
    const limitPrice = orderType === 'LIMIT' && price > 0 ? price - buffer : price;
    const order = {
        orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE',
        orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }]
    };
    if (orderType === 'LIMIT' && limitPrice > 0) {
        order.price = limitPrice.toFixed(2);
        log('ORDER', `SELL LIMIT @ $${limitPrice.toFixed(2)}`, { signal: price, buffer, reason });
    }
    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const lat = Date.now() - t0;
        log('ORDER', `SELL ${quantity} ${ticker} (${reason})`, { orderType, session, latency: lat });
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${lat}ms`, 'sell');
        return { success: true, latency: lat };
    } catch (e) {
        log('ERROR', `SELL failed: ${ticker}`, { error: e.response?.data?.message || e.message, reason });
        return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 };
    }
}

// v1.3.0: Place a STOP LOSS order (safety net on TOS)
// If current price is already at/below stop → sell at market immediately
// If stop is rejected → sell at market (price already at stop level)
async function placeStopOrder(ticker, quantity, stopPrice) {
    const t0 = Date.now(), session = getSessionType();
    const buffer = getLimitBuffer();

    // First check: is the current price already at or below the stop?
    // If so, a stop order would be rejected — sell at market instead
    const currentPrice = await getCurrentPrice(ticker);
    if (currentPrice > 0 && currentPrice <= stopPrice) {
        log('STOP', `Price $${currentPrice.toFixed(2)} already at/below stop $${stopPrice.toFixed(2)} — selling at market`, {
            ticker, quantity
        });
        const sellResult = await placeSellOrder(ticker, quantity, 'STOP_IMMEDIATE', currentPrice);
        return { success: sellResult.success, orderId: null, latency: Date.now() - t0, immediate: true };
    }

    // Regular hours: STOP order (becomes market when triggered)
    // Extended hours: STOP_LIMIT (must have limit price for SEAMLESS session)
    const useStopLimit = !isRegularHours();
    const orderType = useStopLimit ? 'STOP_LIMIT' : 'STOP';

    const order = {
        orderType,
        session,
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        stopPrice: parseFloat(stopPrice.toFixed(2)),
        orderLegCollection: [{
            instruction: 'SELL',
            quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    if (useStopLimit) {
        order.price = parseFloat((stopPrice - buffer).toFixed(2));
    }

    log('STOP', `Submitting ${orderType} ${quantity} ${ticker}`, {
        stopPrice: order.stopPrice,
        currentBid: currentPrice,
        session
    });

    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const lat = Date.now() - t0;
        const orderId = r.headers.location?.split('/').pop();
        log('STOP', `Placed ${orderType} ${quantity} ${ticker} @ $${stopPrice.toFixed(2)}`, {
            orderId, session, latency: lat
        });
        return { success: true, orderId, latency: lat };
    } catch (e) {
        const errMsg = e.response?.data?.message || e.message || '';
        log('ERROR', `STOP rejected: ${ticker}`, {
            error: errMsg,
            statusCode: e.response?.status,
            stopPrice: stopPrice.toFixed(2)
        });

        // If rejected because price is at/below stop → sell at market
        if (errMsg.toLowerCase().includes('stop price') || errMsg.toLowerCase().includes('below the bid')) {
            log('STOP', `Stop rejected — price at stop level, selling at market`, { ticker, quantity });
            const sellResult = await placeSellOrder(ticker, quantity, 'STOP_REJECTED_SELL', stopPrice);
            return { success: sellResult.success, orderId: null, latency: Date.now() - t0, immediate: true };
        }

        return { success: false, error: errMsg, latency: Date.now() - t0 };
    }
}

// v1.3.0: Cancel a specific order by ID (for stop ratcheting)
async function cancelOrder(orderId) {
    if (!orderId) return false;
    try {
        await api.delete(`/accounts/${getAccountId()}/orders/${orderId}`);
        log('ORDER', `Cancelled order ${orderId}`);
        return true;
    } catch (e) {
        log('WARN', `Cancel order ${orderId} failed`, { status: e.response?.status });
        return false;
    }
}

async function cancelOrdersForTicker(ticker) {
    try {
        const now = new Date(), todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts/${getAccountId()}/orders`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
            params: { fromEnteredTime: todayStart, toEnteredTime: now.toISOString() },
            httpsAgent: keepAliveAgent, timeout: 10000
        });
        let cancelled = 0;
        for (const o of (r.data || [])) {
            const leg = o.orderLegCollection?.[0], st = o.status;
            if (leg?.instrument?.symbol === ticker && ['WORKING','QUEUED','ACCEPTED','PENDING_ACTIVATION'].includes(st)) {
                try {
                    await api.delete(`/accounts/${getAccountId()}/orders/${o.orderId}`);
                    cancelled++;
                    log('ORDER', `Cancelled ${o.orderId} for ${ticker}`, { status: st });
                } catch (e) {
                    log('WARN', `Cancel failed: ${o.orderId}`, { status: e.response?.status });
                }
            }
        }
        if (cancelled > 0) log('ORDER', `Cancelled ${cancelled} orders for ${ticker}`);
        return cancelled;
    } catch (e) {
        log('WARN', 'Cancel orders failed', { error: e.response?.status || e.message });
        return 0;
    }
}

async function checkOrphanPositions(pt) {
    if (!isBrokerOrphanImportEnabled()) return;
    if (!isAuthenticated() || !accountHash) return;
    try {
        const schwab = await getPositionsFromSchwab();
        for (const p of schwab) {
            const sym = p.instrument?.symbol, qty = p.longQuantity || 0;
            if (!sym || qty <= 0) continue;
            if (!pt.getPosition(sym)) {
                const avg = p.averagePrice || 0;
                log('WARN', `ORPHAN detected: ${sym} x${qty} @ $${avg.toFixed(2)}`);
                await notify(`⚠️ ORPHAN: ${sym} x${qty}`, 'error');
                pt.openPosition(sym, avg, qty, { path: 'ORPHAN' });
                pt.markOrphan(sym);
            }
        }
    } catch (e) { log('DEBUG', `Orphan check: ${e.message}`); }
}

async function closeOrphanPositions(pt) {
    if (!isBrokerOrphanImportEnabled()) return;
    if (!isAuthenticated()) return;
    for (const o of pt.getOrphans(parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5'))) {
        log('WARN', `Auto-closing orphan: ${o.ticker} x${o.remainingQuantity}`, { tradeId: o.tradeId });
        const r = await placeSellOrder(o.ticker, o.remainingQuantity, 'ORPHAN_AUTO_CLOSE', o.entryPrice);
        if (r.success) {
            pt.closePosition(o.ticker, o.entryPrice, 'ORPHAN_AUTO_CLOSE');
            await notify(`🔴 AUTO-CLOSED orphan: ${o.ticker}`, 'error');
        }
    }
}

async function checkHeartbeats(pt) {
    if (!isAuthenticated()) return;
    const timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_SECS || '60');
    const expired = pt.getHeartbeatExpired(timeout);

    for (const pos of expired) {
        const age = Math.round((Date.now() - pos.lastSignalTime) / 1000);
        log('WARN', `💔 HEARTBEAT EXPIRED: ${pos.ticker}`, { tradeId: pos.tradeId, ageSecs: age, timeout });

        // Mark as closing so heartbeat ratcheting skips this position
        pos.isClosing = true;

        let sellPrice = pos.entryPrice;
        const currentPrice = await getCurrentPrice(pos.ticker);
        if (currentPrice > 0) {
            sellPrice = currentPrice;
            log('INFO', `💔 ${pos.ticker}: entry $${pos.entryPrice.toFixed(2)}, current $${currentPrice.toFixed(2)}`);
        } else {
            log('WARN', `💔 ${pos.ticker}: using entry price as fallback`);
        }

        // Cancel stop by ID first, then all orders, then wait
        if (pos.stopOrderId) {
            await cancelOrder(pos.stopOrderId);
            log('STOP', `Cancelled stop ${pos.stopOrderId} before heartbeat close`, { ticker: pos.ticker });
        }
        await cancelOrdersForTicker(pos.ticker);
        await new Promise(r => setTimeout(r, 500));

        const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'HEARTBEAT_EXPIRED', sellPrice);

        if (result.success) {
            // Journal the heartbeat expired event
            journalTrade({
                action: 'HEARTBEAT_EXPIRED',
                tradeId: pos.tradeId,
                ticker: pos.ticker,
                entryPrice: pos.entryPrice,
                sellPrice,
                ageSecs: age,
                remaining: pos.remainingQuantity
            });

            const summary = pt.closePosition(pos.ticker, sellPrice, 'HEARTBEAT_EXPIRED');
            await notify(
                `💔 HEARTBEAT EXPIRED: ${pos.ticker} x${summary.remainingClosed}\n` +
                `TradeID: ${summary.tradeId}\n` +
                `No signal for ${age}s — BUY likely repainted\n` +
                `Sold @ $${sellPrice.toFixed(2)} (current market)\n` +
                `P&L: $${summary.pnl.toFixed(2)} | Total: $${summary.totalPnL.toFixed(2)}`,
                'error'
            );
        }
    }
}

function startOrphanCheck(pt) {
    if (orphanCheckTimer) clearInterval(orphanCheckTimer);
    orphanCheckTimer = setInterval(async () => {
        await checkOrphanPositions(pt);
        await closeOrphanPositions(pt);
    }, 60 * 1000);
    log('INFO', `Orphan checker started (1 min, broker import: ${isBrokerOrphanImportEnabled() ? 'enabled' : 'disabled'})`);
}

function startHeartbeatCheck(pt) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
        await checkHeartbeats(pt);
    }, 30 * 1000);
    log('INFO', `Heartbeat checker started (30s, timeout: ${process.env.HEARTBEAT_TIMEOUT_SECS || '60'}s)`);
}

// v1.3.0: Floor monitor — checks price every 5s against profit floor
// Replicates Pine's floor logic server-side so we don't wait for heartbeat
let floorMonitorTimer = null;

function calculateFloor(profitPct) {
    // Mirror Pine's floor milestones exactly
    const FLOOR_AT_1 = parseFloat(process.env.FLOOR_AT_1PCT || '0');
    const FLOOR_AT_2 = parseFloat(process.env.FLOOR_AT_2PCT || '0.5');
    const FLOOR_AT_3 = parseFloat(process.env.FLOOR_AT_3PCT || '1.5');
    const FLOOR_AT_4 = parseFloat(process.env.FLOOR_AT_4PCT || '2.5');
    const TRAIL_GAP  = parseFloat(process.env.FLOOR_TRAIL_GAP || '1.5');

    if (profitPct >= 4) return Math.max(FLOOR_AT_4, profitPct - TRAIL_GAP);
    if (profitPct >= 3) return FLOOR_AT_3;
    if (profitPct >= 2) return FLOOR_AT_2;
    if (profitPct >= 1) return FLOOR_AT_1;
    return -999; // no floor yet
}

async function checkFloors(pt) {
    if (!isAuthenticated()) return;
    const allPositions = pt.getAllPositions();
    if (allPositions.length === 0) return;

    for (const pos of allPositions) {
        if (!pos.remainingQuantity || pos.remainingQuantity <= 0) continue;
        if (pos.isClosing || pos.isOrphan) continue;

        // Fetch current price
        const currentPrice = await getCurrentPrice(pos.ticker);
        if (currentPrice <= 0) continue;

        const profitPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
        const floorPct = calculateFloor(profitPct);

        // HARD STOP: if price dropped below entry - STOP_LOSS_CENTS, sell immediately
        // This catches the case where the TRIGGER's child STOP was rejected
        const stopCents = parseFloat(process.env.STOP_LOSS_CENTS || '0.02');
        const hardStopPrice = pos.entryPrice - stopCents;
        if (currentPrice <= hardStopPrice) {
            log('FLOOR', `🛑 HARD STOP: ${pos.ticker} price $${currentPrice.toFixed(2)} <= stop $${hardStopPrice.toFixed(2)}`, {
                tradeId: pos.tradeId, entryPrice: pos.entryPrice, profitPct: profitPct.toFixed(2)
            });
            pos.isClosing = true;
            await cancelOrdersForTicker(pos.ticker);
            await new Promise(r => setTimeout(r, 300));
            const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'HARD_STOP', currentPrice);
            if (result.success) {
                journalTrade({
                    action: 'HARD_STOP',
                    tradeId: pos.tradeId,
                    ticker: pos.ticker,
                    entryPrice: pos.entryPrice,
                    sellPrice: currentPrice,
                    hardStopPrice,
                    profitPct: profitPct.toFixed(2)
                });
                const summary = pt.closePosition(pos.ticker, currentPrice, 'HARD_STOP');
                if (summary) {
                    await notify(
                        `🛑 HARD STOP: ${pos.ticker}\n` +
                        `TradeID: ${summary.tradeId}\n` +
                        `Entry $${summary.entryPrice.toFixed(2)} → Stop $${hardStopPrice.toFixed(2)} → Sold $${currentPrice.toFixed(2)}\n` +
                        `P&L: $${summary.pnl.toFixed(2)}`,
                        'loss'
                    );
                }
            }
            continue;
        }

        // No floor active yet (profit below 1%) — skip floor logic but hard stop above already covers
        if (floorPct <= -999) continue;

        const floorPrice = pos.entryPrice * (1 + floorPct / 100);
        const currentStop = pos.currentStopPrice || 0;

        // Check if price breached the floor — emergency sell
        if (currentPrice <= floorPrice && floorPct >= 0) {
            log('FLOOR', `🚨 FLOOR BREACH (server): ${pos.ticker} price $${currentPrice.toFixed(2)} <= floor $${floorPrice.toFixed(2)}`, {
                tradeId: pos.tradeId, profitPct: profitPct.toFixed(2), floorPct: floorPct.toFixed(2)
            });
            pos.isClosing = true;
            if (pos.stopOrderId) {
                await cancelOrder(pos.stopOrderId);
            }
            await cancelOrdersForTicker(pos.ticker);
            await new Promise(r => setTimeout(r, 300));
            const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'SERVER_FLOOR_BREACH', currentPrice);
            if (result.success) {
                journalTrade({
                    action: 'SERVER_FLOOR_BREACH',
                    tradeId: pos.tradeId,
                    ticker: pos.ticker,
                    entryPrice: pos.entryPrice,
                    sellPrice: currentPrice,
                    floorPrice,
                    floorPct: floorPct.toFixed(2),
                    profitPct: profitPct.toFixed(2)
                });
                const summary = pt.closePosition(pos.ticker, currentPrice, 'SERVER_FLOOR_BREACH');
                if (summary) {
                    await notify(
                        `🚨 SERVER FLOOR BREACH: ${pos.ticker}\n` +
                        `TradeID: ${summary.tradeId}\n` +
                        `Price $${currentPrice.toFixed(2)} hit floor $${floorPrice.toFixed(2)}\n` +
                        `P&L: $${summary.pnl.toFixed(2)} | Total: $${summary.totalPnL.toFixed(2)}`,
                        summary.totalPnL >= 0 ? 'profit' : 'loss'
                    );
                }
            }
            continue;
        }

        // Ratchet stop up if floor increased
        if (floorPrice > currentStop) {
            log('FLOOR', `Ratcheting stop for ${pos.ticker}: $${currentStop.toFixed(2)} → $${floorPrice.toFixed(2)}`, {
                tradeId: pos.tradeId, profitPct: profitPct.toFixed(2), floorPct: floorPct.toFixed(2)
            });
            if (pos.stopOrderId) {
                await cancelOrder(pos.stopOrderId);
            }
            const stopResult = await placeStopOrder(pos.ticker, pos.remainingQuantity, floorPrice);
            if (stopResult.success) {
                pt.updateStopPrice(pos.ticker, floorPrice, stopResult.orderId);
            }
        }
    }
}

async function getOrderDetails(orderId) {
    if (!orderId) return null;
    try {
        const r = await api.get(`/accounts/${getAccountId()}/orders/${orderId}`);
        const order = r.data || {};
        const activities = order.orderActivityCollection || [];
        let filledQuantity = 0;
        let filledNotional = 0;

        for (const act of activities) {
            const legs = act?.executionLegs || [];
            for (const leg of legs) {
                const qty = Number(leg.quantity || 0);
                const px = Number(leg.price || 0);
                if (qty > 0) {
                    filledQuantity += qty;
                    filledNotional += qty * px;
                }
            }
        }

        return {
            status: order.status || 'UNKNOWN',
            filledQuantity,
            averageFillPrice: filledQuantity > 0 ? filledNotional / filledQuantity : 0,
            order
        };
    } catch (e) {
        log('WARN', `Could not get order details for ${orderId}`, {
            error: e.response?.status || e.message
        });
        return null;
    }
}

async function placeManagedBuyOrder(ticker, quantity, price) {
    const t0 = Date.now();
    const session = getSessionType();
    const buyOrderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();
    const order = {
        orderStrategyType: 'SINGLE',
        orderType: buyOrderType,
        session,
        duration: 'DAY',
        orderLegCollection: [{
            instruction: 'BUY',
            quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    if (buyOrderType === 'LIMIT' && price > 0) {
        order.price = parseFloat((price + buffer).toFixed(2));
    }

    log('ORDER', `BUY ${quantity} ${ticker}`, {
        buyType: buyOrderType,
        session,
        signalPrice: price,
        limitPrice: order.price || null
    });

    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - t0;
        const orderId = r.headers.location?.split('/').pop();
        log('ORDER', `BUY placed ${quantity} ${ticker}`, {
            orderId,
            session,
            latency,
            orderType: buyOrderType
        });
        await notify(`BUY ${quantity} ${ticker} | ${buyOrderType} ${session} | ${latency}ms`, 'buy');
        return {
            success: true,
            orderId,
            latency,
            orderType: buyOrderType,
            session,
            needsFillConfirmation: buyOrderType === 'LIMIT'
        };
    } catch (e) {
        log('ERROR', `BUY failed: ${ticker}`, {
            error: e.response?.data?.message || e.message,
            statusCode: e.response?.status
        });
        return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 };
    }
}

async function syncPendingEntries(pt, ticker = null) {
    if (!isAuthenticated()) return [];

    const pendingEntries = ticker
        ? [pt.getPendingEntry(ticker)].filter(Boolean)
        : pt.getAllPendingEntries();

    if (!pendingEntries.length) return [];

    const brokerPositions = await getPositionsFromSchwab();
    const activated = [];
    const now = Date.now();

    for (const pending of pendingEntries) {
        const orderDetails = await getOrderDetails(pending.orderId);
        if (orderDetails?.filledQuantity > 0) {
            const pos = pt.activatePendingEntry(
                pending.ticker,
                orderDetails.averageFillPrice || pending.signalPrice || 0,
                orderDetails.filledQuantity,
                {
                    source: 'order_details'
                }
            );
            if (pos) {
                activated.push(pos);
                await notify(
                    `ENTRY CONFIRMED ${pending.ticker}\n` +
                    `TradeID: ${pos.tradeId}\n` +
                    `Qty: ${orderDetails.filledQuantity} @ $${(orderDetails.averageFillPrice || pending.signalPrice || 0).toFixed(2)}`,
                    'buy'
                );
            }
            continue;
        }

        const brokerPos = findBrokerPosition(brokerPositions, pending.ticker);
        if (brokerPos) {
            const quantity = brokerPos.longQuantity || pending.requestedQuantity || 0;
            const fillPrice = brokerPos.averagePrice || pending.signalPrice || 0;
            const pos = pt.activatePendingEntry(pending.ticker, fillPrice, quantity, {
                source: 'schwab_positions'
            });
            if (pos) {
                activated.push(pos);
                await notify(
                    `ENTRY CONFIRMED ${pending.ticker}\n` +
                    `TradeID: ${pos.tradeId}\n` +
                    `Qty: ${quantity} @ $${fillPrice.toFixed(2)}`,
                    'buy'
                );
            }
            continue;
        }

        const ageSecs = Math.round((now - new Date(pending.createdAt).getTime()) / 1000);
        if (ageSecs >= getPendingEntryTimeoutSecs()) {
            log('WARN', `Pending entry still unfilled: ${pending.ticker}`, {
                tradeId: pending.tradeId,
                orderId: pending.orderId,
                status: orderDetails?.status || 'UNKNOWN',
                ageSecs
            });
        }
    }

    return activated;
}

function decideServerScale(pos, profitPct) {
    if (!isServerManagedScalesEnabled()) return null;

    const config = getScaleConfig();
    if (profitPct >= config.fast4Thresh && !pos.hit2pct && !pos.hitFast4pct) {
        return { level: 'FAST4', sellPct: config.fast4SellPct };
    }
    if (profitPct >= config.pct2Thresh && !pos.hit2pct && !pos.hitFast4pct) {
        return { level: 'PCT2', sellPct: config.pct2SellPct };
    }
    if (profitPct >= config.pct4After2Thresh && pos.hit2pct && !pos.hit4after2) {
        return { level: 'PCT4_AFTER2', sellPct: config.pct4After2SellPct };
    }
    return null;
}

async function checkManagedExits(pt) {
    if (!isAuthenticated()) return;

    await syncPendingEntries(pt);

    const allPositions = pt.getAllPositions().filter(pos => pos.remainingQuantity > 0 && !pos.isClosing && !pos.isOrphan);
    if (allPositions.length === 0) return;

    const prices = await getCurrentPrices(allPositions.map(pos => pos.ticker));
    const stopCents = parseFloat(process.env.STOP_LOSS_CENTS || '0.02');

    for (const pos of allPositions) {
        const currentPrice = prices[pos.ticker] || 0;
        if (currentPrice <= 0) continue;

        const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const hardStopPrice = pos.entryPrice - stopCents;

        if (currentPrice <= hardStopPrice) {
            log('FLOOR', `HARD STOP: ${pos.ticker} price $${currentPrice.toFixed(2)} <= stop $${hardStopPrice.toFixed(2)}`, {
                tradeId: pos.tradeId,
                entryPrice: pos.entryPrice,
                profitPct: profitPct.toFixed(2)
            });
            pos.isClosing = true;
            await cancelOrdersForTicker(pos.ticker);
            await new Promise(resolve => setTimeout(resolve, 300));
            const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'HARD_STOP', currentPrice);
            if (result.success) {
                journalTrade({
                    action: 'HARD_STOP',
                    tradeId: pos.tradeId,
                    ticker: pos.ticker,
                    entryPrice: pos.entryPrice,
                    sellPrice: currentPrice,
                    hardStopPrice,
                    profitPct: profitPct.toFixed(2)
                });
                const summary = pt.closePosition(pos.ticker, currentPrice, 'HARD_STOP');
                if (summary) {
                    await notify(
                        `HARD STOP: ${pos.ticker}\n` +
                        `TradeID: ${summary.tradeId}\n` +
                        `Entry $${summary.entryPrice.toFixed(2)} -> Stop $${hardStopPrice.toFixed(2)} -> Sold $${currentPrice.toFixed(2)}\n` +
                        `P&L: $${summary.pnl.toFixed(2)}`,
                        'loss'
                    );
                }
            } else {
                pos.isClosing = false;
            }
            continue;
        }

        const serverScale = decideServerScale(pos, profitPct);
        if (serverScale) {
            const preview = pt.previewScalePosition(pos.ticker, serverScale.sellPct, currentPrice);
            if (preview && preview.sharesToSell > 0) {
                const scaleResult = await placeSellOrder(
                    pos.ticker,
                    preview.sharesToSell,
                    `Server scale ${serverScale.level} (${serverScale.sellPct}%)`,
                    currentPrice
                );

                if (scaleResult.success) {
                    pt.markMilestone(pos.ticker, serverScale.level);
                    pt.scalePosition(pos.ticker, serverScale.sellPct, serverScale.level, currentPrice);
                    log('FLOOR', `SERVER SCALE ${pos.ticker} ${serverScale.level}`, {
                        tradeId: pos.tradeId,
                        profitPct: profitPct.toFixed(2),
                        sellPct: serverScale.sellPct
                    });
                }
            }
        }

        const floorPct = calculateFloor(profitPct);
        if (floorPct <= -999) continue;

        const floorPrice = pos.entryPrice * (1 + floorPct / 100);
        const currentStop = pos.currentStopPrice || 0;

        if (currentPrice <= floorPrice && floorPct >= 0) {
            log('FLOOR', `SERVER FLOOR BREACH: ${pos.ticker} price $${currentPrice.toFixed(2)} <= floor $${floorPrice.toFixed(2)}`, {
                tradeId: pos.tradeId,
                profitPct: profitPct.toFixed(2),
                floorPct: floorPct.toFixed(2)
            });
            pos.isClosing = true;
            await cancelOrdersForTicker(pos.ticker);
            await new Promise(resolve => setTimeout(resolve, 300));
            const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'SERVER_FLOOR_BREACH', currentPrice);
            if (result.success) {
                journalTrade({
                    action: 'SERVER_FLOOR_BREACH',
                    tradeId: pos.tradeId,
                    ticker: pos.ticker,
                    entryPrice: pos.entryPrice,
                    sellPrice: currentPrice,
                    floorPrice,
                    floorPct: floorPct.toFixed(2),
                    profitPct: profitPct.toFixed(2)
                });
                const summary = pt.closePosition(pos.ticker, currentPrice, 'SERVER_FLOOR_BREACH');
                if (summary) {
                    await notify(
                        `SERVER FLOOR BREACH: ${pos.ticker}\n` +
                        `TradeID: ${summary.tradeId}\n` +
                        `Price $${currentPrice.toFixed(2)} hit floor $${floorPrice.toFixed(2)}\n` +
                        `P&L: $${summary.pnl.toFixed(2)} | Total: $${summary.totalPnL.toFixed(2)}`,
                        summary.totalPnL >= 0 ? 'profit' : 'loss'
                    );
                }
            } else {
                pos.isClosing = false;
            }
            continue;
        }

        if (floorPrice > currentStop) {
            log('FLOOR', `Virtual stop for ${pos.ticker}: $${currentStop.toFixed(2)} -> $${floorPrice.toFixed(2)}`, {
                tradeId: pos.tradeId,
                profitPct: profitPct.toFixed(2),
                floorPct: floorPct.toFixed(2)
            });
            pt.updateStopPrice(pos.ticker, floorPrice, null);
        }
    }
}

function startPendingEntryMonitor(pt) {
    if (pendingEntryTimer) clearInterval(pendingEntryTimer);
    const intervalSecs = getPendingEntryCheckIntervalSecs();
    pendingEntryTimer = setInterval(async () => {
        await syncPendingEntries(pt);
    }, intervalSecs * 1000);
    log('INFO', `Pending-entry monitor started (${intervalSecs}s)`);
}

function startFloorMonitor(pt) {
    if (floorMonitorTimer) clearInterval(floorMonitorTimer);
    const intervalSecs = getFloorCheckIntervalSecs();
    floorMonitorTimer = setInterval(async () => {
        await checkManagedExits(pt);
    }, intervalSecs * 1000);
    log('INFO', `Floor monitor started (${intervalSecs}s)`);
}

module.exports = {
    schwabService: {
        getAuthUrl, exchangeCodeForTokens, refreshAccessToken, startTokenRefresh,
        isAuthenticated, getTokenStatus, placeBuyOrder: placeManagedBuyOrder, placeSellOrder,
        placeSellWithStop, placeStopOrder, cancelOrder, getOrderFillPrice, getOrderDetails,
        getPositionsFromSchwab, getCurrentPrice, getCurrentPrices, cancelOrdersForTicker,
        getAccessToken, setAccountHash, getAccountHash, fetchAccountHash, getAccountId,
        isRegularHours, getSessionType,
        checkOrphanPositions, closeOrphanPositions, startOrphanCheck,
        checkHeartbeats, startHeartbeatCheck,
        checkFloors: checkManagedExits, startFloorMonitor,
        syncPendingEntries, startPendingEntryMonitor
    }
};
