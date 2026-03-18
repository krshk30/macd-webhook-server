/**
 * Schwab Trader API Service v1.2.2
 *
 * v1.2.2: Fixed orphan/positions 400 error — uses /accounts endpoint
 *         instead of /accounts/{hash}?fields=positions
 * v1.2.1: fetchAccountHash retry, auth callback delay, error logging
 * v1.2:   Extended hours LIMIT orders, orphan position safety
 * v1.1:   Account hash auto-fetch, /debug/schwab
 * v1.0:   OAuth2, token refresh, bracket orders
 */

const axios = require('axios');
const { log } = require('./logger');
const { notify } = require('./notifications');

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';

const https = require('https');
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

let tokens = { access_token: null, refresh_token: null, expires_at: 0, token_type: 'Bearer' };
let accountHash = null;
let refreshTimer = null;
let orphanCheckTimer = null;

const api = axios.create({
    baseURL: SCHWAB_API_BASE,
    httpsAgent: keepAliveAgent,
    timeout: 5000,
    headers: { 'Content-Type': 'application/json' }
});

api.interceptors.request.use(config => {
    if (tokens.access_token) config.headers.Authorization = `Bearer ${tokens.access_token}`;
    return config;
});

// ─── Market Hours ──────────────────────────────────────────────

function getEasternTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isRegularHours() {
    const et = getEasternTime();
    const totalMins = et.getHours() * 60 + et.getMinutes();
    return totalMins >= 570 && totalMins < 960; // 9:30 AM - 4:00 PM ET
}

function getSessionType() { return isRegularHours() ? 'NORMAL' : 'SEAMLESS'; }

function getOrderType(requestedType, price) {
    if (isRegularHours()) return requestedType;
    if (requestedType === 'MARKET' && price && price > 0) {
        log('ORDER', `Extended hours — converting MARKET → LIMIT @ $${price.toFixed(2)}`);
        return 'LIMIT';
    }
    return requestedType;
}

// ─── OAuth2 ────────────────────────────────────────────────────

function getAuthUrl() {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const callbackUrl = process.env.SCHWAB_CALLBACK_URL;
    return `${SCHWAB_AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
}

async function exchangeCodeForTokens(authCode) {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    const callbackUrl = process.env.SCHWAB_CALLBACK_URL;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
        const response = await axios.post(SCHWAB_TOKEN_URL,
            new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: callbackUrl }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent }
        );
        tokens.access_token = response.data.access_token;
        tokens.refresh_token = response.data.refresh_token;
        tokens.expires_at = Date.now() + (response.data.expires_in * 1000);
        tokens.token_type = response.data.token_type || 'Bearer';
        log('INFO', 'OAuth tokens obtained successfully');
        startTokenRefresh();
        return true;
    } catch (err) {
        log('ERROR', `Token exchange failed: ${err.response?.data?.error || err.message}`);
        return false;
    }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) { log('WARN', 'No refresh token — re-auth required'); return false; }
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');

    try {
        const response = await axios.post(SCHWAB_TOKEN_URL,
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent }
        );
        tokens.access_token = response.data.access_token;
        tokens.expires_at = Date.now() + (response.data.expires_in * 1000);
        if (response.data.refresh_token) tokens.refresh_token = response.data.refresh_token;
        log('INFO', `Token refreshed. Expires in ${response.data.expires_in}s`);
        return true;
    } catch (err) {
        log('ERROR', `Token refresh failed: ${err.response?.data?.error || err.message}`);
        await notify('TOKEN REFRESH FAILED — re-authentication required', 'error');
        return false;
    }
}

function startTokenRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => { log('INFO', 'Proactive token refresh...'); await refreshAccessToken(); }, 25 * 60 * 1000);
    log('INFO', 'Token auto-refresh timer started (every 25 min)');
}

function isAuthenticated() { return tokens.access_token && Date.now() < tokens.expires_at; }

function getTokenStatus() {
    if (!tokens.access_token) return 'no_token';
    if (Date.now() >= tokens.expires_at) return 'expired';
    return `valid (${Math.round((tokens.expires_at - Date.now()) / 60000)}m remaining)`;
}

// ─── Account Hash ──────────────────────────────────────────────

function getAccessToken() { return tokens.access_token; }
function setAccountHash(hash) { accountHash = hash; log('INFO', `Account hash stored: ${hash.substring(0, 10)}...`); }
function getAccountHash() { return accountHash; }

async function fetchAccountHash() {
    if (!tokens.access_token) return null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await api.get('/accounts/accountNumbers');
            if (response.data && Array.isArray(response.data) && response.data.length > 0) {
                accountHash = response.data[0].hashValue;
                log('INFO', `Account hash fetched: ${response.data[0].accountNumber} → ${accountHash.substring(0, 10)}...`);
                return accountHash;
            }
        } catch (err) {
            log('WARN', `Account hash attempt ${attempt} failed (${err.response?.status || 'error'})`);
            if (attempt < 2) { log('INFO', 'Retrying in 3s...'); await new Promise(r => setTimeout(r, 3000)); }
        }
    }
    log('ERROR', 'Account hash failed after retries — use /debug/schwab to retry');
    return null;
}

function getAccountId() {
    if (accountHash) return accountHash;
    return process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID;
}

// ─── Fetch Positions from Schwab ───────────────────────────────
// v1.2.2: Uses /accounts (list all) instead of /accounts/{hash}?fields=positions
// The single-account endpoint returns 400 for Individual API apps,
// but /accounts works reliably and returns positions by default.

async function getPositionsFromSchwab() {
    try {
        // Step 1: Get positions via /accounts (no fields param)
        const response = await api.get('/accounts');
        const allAccounts = response.data || [];
        const account = allAccounts.find(a => a.securitiesAccount) || allAccounts[0] || {};
        const positions = account?.securitiesAccount?.positions || [];
        
        // If positions found, return them
        if (positions.length > 0) return positions;
        
        // Step 2: If empty, try single account with hash
        if (accountHash) {
            try {
                const r2 = await api.get(`/accounts/${accountHash}`);
                return r2.data?.securitiesAccount?.positions || [];
            } catch (e) {
                // Silent fail — just means no positions
            }
        }
        
        return [];
    } catch (err) {
        log('DEBUG', `Positions check: ${err.response?.status || err.message}`);
        return [];
    }
}

// ─── Order Placement ───────────────────────────────────────────

async function placeBuyOrder(ticker, quantity, price) {
    const startTime = Date.now();
    const session = getSessionType();
    const orderType = getOrderType('MARKET', price);

    const order = {
        orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE',
        orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }]
    };
    if (orderType === 'LIMIT' && price > 0) order.price = price.toFixed(2);

    try {
        const response = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();
        log('ORDER', `BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms | Order: ${orderId}`);
        await notify(`BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms`, 'buy');
        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        log('ERROR', `BUY failed: ${err.response?.data?.message || err.message} | ${latency}ms`);
        return { success: false, error: err.response?.data?.message || err.message, latency };
    }
}

async function placeSellOrder(ticker, quantity, reason, price) {
    const startTime = Date.now();
    const session = getSessionType();
    const orderType = getOrderType('MARKET', price);

    const order = {
        orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE',
        orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }]
    };
    if (orderType === 'LIMIT' && price > 0) order.price = price.toFixed(2);

    try {
        const response = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();
        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`);
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`, 'sell');
        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        log('ERROR', `SELL failed: ${err.response?.data?.message || err.message} | ${latency}ms`);
        return { success: false, error: err.response?.data?.message || err.message, latency };
    }
}

async function placeBracketOrder(ticker, quantity, tpPrice, slPrice) {
    const startTime = Date.now();
    const session = getSessionType();
    const entryType = isRegularHours() ? 'MARKET' : 'LIMIT';

    const order = {
        orderType: entryType, session, duration: 'DAY', orderStrategyType: 'TRIGGER',
        orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }],
        childOrderStrategies: [
            {
                orderType: 'LIMIT', session, duration: 'DAY', price: tpPrice.toFixed(2), orderStrategyType: 'SINGLE',
                orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }]
            },
            {
                orderType: 'STOP', session, duration: 'DAY', stopPrice: slPrice.toFixed(2), orderStrategyType: 'SINGLE',
                orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }]
            }
        ]
    };

    if (entryType === 'LIMIT') {
        const entryPrice = (tpPrice + slPrice) / 2;
        order.price = entryPrice.toFixed(2);
        log('ORDER', `Extended hours: LIMIT entry @ $${entryPrice.toFixed(2)}`);
    }

    try {
        const response = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();
        log('ORDER', `BRACKET BUY ${quantity} ${ticker} TP:$${tpPrice.toFixed(2)} SL:$${slPrice.toFixed(2)} | ${session} | ${latency}ms`);
        await notify(`BRACKET BUY ${quantity} ${ticker}\nTP: $${tpPrice.toFixed(2)} | SL: $${slPrice.toFixed(2)} | ${session} | ${latency}ms`, 'buy');
        return { success: true, orderId, latency };
    } catch (err) {
        log('ERROR', `BRACKET failed: ${err.response?.data?.message || err.message}`);
        log('WARN', 'Falling back to simple buy...');
        return await placeBuyOrder(ticker, quantity, (tpPrice + slPrice) / 2);
    }
}

// ─── Orphan Position Safety Net (v1.2.2) ───────────────────────
// Uses /accounts endpoint which works reliably (no 400 errors)

async function checkOrphanPositions(positionsTracker) {
    if (!isAuthenticated()) return;
    if (!accountHash) { log('DEBUG', 'Orphan check skipped — no account hash'); return; }

    try {
        const schwabPositions = await getPositionsFromSchwab();

        for (const pos of schwabPositions) {
            const symbol = pos.instrument?.symbol;
            const qty = pos.longQuantity || 0;
            if (!symbol || qty <= 0) continue;

            const tracked = positionsTracker.getPosition(symbol);
            if (!tracked) {
                const avgPrice = pos.averagePrice || 0;
                log('WARN', `ORPHAN POSITION: ${symbol} x${qty} @ $${avgPrice.toFixed(2)} — not tracked`);
                await notify(
                    `⚠️ ORPHAN: ${symbol} x${qty} @ $${avgPrice.toFixed(2)}\n` +
                    `Position on Schwab but no signal tracker.\n` +
                    `Auto-close in ${process.env.ORPHAN_TIMEOUT_MINS || 5} mins.`,
                    'error'
                );
                positionsTracker.openPosition(symbol, avgPrice, qty);
                positionsTracker.markOrphan(symbol);
            }
        }
    } catch (err) {
        log('WARN', `Orphan check error: ${err.message}`);
    }
}

async function closeOrphanPositions(positionsTracker) {
    if (!isAuthenticated()) return;
    const timeoutMins = parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5');
    const orphans = positionsTracker.getOrphans(timeoutMins);

    for (const orphan of orphans) {
        log('WARN', `Auto-closing orphan: ${orphan.ticker} x${orphan.remainingQuantity}`);
        const result = await placeSellOrder(orphan.ticker, orphan.remainingQuantity, 'ORPHAN_AUTO_CLOSE', orphan.entryPrice);
        if (result.success) {
            positionsTracker.closePosition(orphan.ticker, orphan.entryPrice, 'ORPHAN_AUTO_CLOSE');
            await notify(`🔴 AUTO-CLOSED ORPHAN: ${orphan.ticker} x${orphan.remainingQuantity}\nNo exit signal within ${timeoutMins} mins.`, 'error');
        }
    }
}

function startOrphanCheck(positionsTracker) {
    if (orphanCheckTimer) clearInterval(orphanCheckTimer);
    orphanCheckTimer = setInterval(async () => {
        await checkOrphanPositions(positionsTracker);
        await closeOrphanPositions(positionsTracker);
    }, 2 * 60 * 1000);
    log('INFO', 'Orphan position checker started (every 2 min)');
}

// ─── Cancel Orders ─────────────────────────────────────────────

async function cancelOrdersForTicker(ticker) {
    try {
        const response = await api.get(`/accounts/${getAccountId()}/orders`, { params: { status: 'QUEUED' } });
        const orders = response.data || [];
        let cancelled = 0;
        for (const order of orders) {
            const leg = order.orderLegCollection?.[0];
            if (leg?.instrument?.symbol === ticker) {
                await api.delete(`/accounts/${getAccountId()}/orders/${order.orderId}`);
                cancelled++;
            }
        }
        if (cancelled > 0) log('ORDER', `Cancelled ${cancelled} open orders for ${ticker}`);
        return cancelled;
    } catch (err) {
        log('ERROR', `Cancel orders failed: ${err.message}`);
        return 0;
    }
}

// ─── Exports ───────────────────────────────────────────────────

const schwabService = {
    getAuthUrl, exchangeCodeForTokens, refreshAccessToken,
    startTokenRefresh, isAuthenticated, getTokenStatus,
    placeBuyOrder, placeSellOrder, placeBracketOrder,
    getPositionsFromSchwab, cancelOrdersForTicker,
    getAccessToken, setAccountHash, getAccountHash,
    fetchAccountHash, getAccountId,
    isRegularHours, getSessionType,
    checkOrphanPositions, closeOrphanPositions, startOrphanCheck
};

module.exports = { schwabService };
