/**
 * Schwab Trader API Service v1.2.4
 *
 * SCHWAB API QUIRKS (DO NOT CHANGE):
 * 1. /accounts/{hash}?fields=positions → 400
 * 2. /accounts?fields=positions → 400
 * 3. /accounts (no params, raw axios) → 200
 * 4. getPositionsFromSchwab MUST use raw axios with Accept header
 * 5. Bracket (TRIGGER) orders fail with SEAMLESS → skip in ext hours
 * 6. Fresh tokens need 3s before account endpoints work
 * 7. All time checks use Eastern, not UTC
 * 8. Position failures log at DEBUG level
 *
 * CHANGELOG:
 * v1.2.4: handleClose zero-quantity guard (server-side)
 * v1.2.3: 1-min orphan check, raw axios for positions
 * v1.2.2: /accounts instead of /accounts/{hash}?fields
 * v1.2.1: fetchAccountHash retry 3s delay
 * v1.2: Extended hours LIMIT, orphan safety
 * v1.1: Account hash auto-fetch, /debug/schwab
 * v1.0: OAuth2, token refresh, bracket orders
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
let refreshTimer = null, orphanCheckTimer = null;

const api = axios.create({ baseURL: SCHWAB_API_BASE, httpsAgent: keepAliveAgent, timeout: 5000, headers: { 'Content-Type': 'application/json' } });
api.interceptors.request.use(config => { if (tokens.access_token) config.headers.Authorization = `Bearer ${tokens.access_token}`; return config; });

// ─── Market Hours ──────────────────────────────────────────────
function getEasternTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function isRegularHours() { const et = getEasternTime(); return (et.getHours() * 60 + et.getMinutes()) >= 570 && (et.getHours() * 60 + et.getMinutes()) < 960; }
function getSessionType() { return isRegularHours() ? 'NORMAL' : 'SEAMLESS'; }
function getOrderType(requestedType, price) {
    if (isRegularHours()) return requestedType;
    if (requestedType === 'MARKET' && price && price > 0) { log('ORDER', `Extended hours — MARKET → LIMIT @ $${price.toFixed(2)}`); return 'LIMIT'; }
    return requestedType;
}

// ─── OAuth2 ────────────────────────────────────────────────────
function getAuthUrl() { return `${SCHWAB_AUTH_URL}?response_type=code&client_id=${process.env.SCHWAB_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SCHWAB_CALLBACK_URL)}`; }

async function exchangeCodeForTokens(authCode) {
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: process.env.SCHWAB_CALLBACK_URL }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens.access_token = r.data.access_token; tokens.refresh_token = r.data.refresh_token;
        tokens.expires_at = Date.now() + (r.data.expires_in * 1000); tokens.token_type = r.data.token_type || 'Bearer';
        log('INFO', 'OAuth tokens obtained'); startTokenRefresh(); return true;
    } catch (err) { log('ERROR', `Token exchange failed: ${err.response?.data?.error || err.message}`); return false; }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) { log('WARN', 'No refresh token'); return false; }
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens.access_token = r.data.access_token; tokens.expires_at = Date.now() + (r.data.expires_in * 1000);
        if (r.data.refresh_token) tokens.refresh_token = r.data.refresh_token;
        log('INFO', `Token refreshed. Expires in ${r.data.expires_in}s`); return true;
    } catch (err) { log('ERROR', `Token refresh failed: ${err.response?.data?.error || err.message}`); await notify('TOKEN REFRESH FAILED', 'error'); return false; }
}

function startTokenRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => { log('INFO', 'Token refresh...'); await refreshAccessToken(); }, 25 * 60 * 1000);
    log('INFO', 'Token auto-refresh started (25 min)');
}
function isAuthenticated() { return tokens.access_token && Date.now() < tokens.expires_at; }
function getTokenStatus() {
    if (!tokens.access_token) return 'no_token'; if (Date.now() >= tokens.expires_at) return 'expired';
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
            const r = await api.get('/accounts/accountNumbers');
            if (r.data?.length > 0) { accountHash = r.data[0].hashValue; log('INFO', `Hash: ${r.data[0].accountNumber} → ${accountHash.substring(0, 10)}...`); return accountHash; }
        } catch (err) { log('WARN', `Hash attempt ${attempt} failed (${err.response?.status})`); if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); } }
    }
    log('ERROR', 'Hash failed — use /debug/schwab'); return null;
}
function getAccountId() { return accountHash || process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID; }

// ─── Fetch Positions (raw axios — NOT api instance) ────────────
async function getPositionsFromSchwab() {
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
            httpsAgent: keepAliveAgent, timeout: 10000
        });
        const account = (r.data || []).find(a => a.securitiesAccount) || r.data?.[0] || {};
        return account?.securitiesAccount?.positions || [];
    } catch (err) { log('DEBUG', `Positions check: ${err.response?.status || err.message}`); return []; }
}

// ─── Order Placement ───────────────────────────────────────────
async function placeBuyOrder(ticker, quantity, price) {
    const startTime = Date.now(); const session = getSessionType(); const orderType = getOrderType('MARKET', price);
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE',
        orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
    if (orderType === 'LIMIT' && price > 0) order.price = price.toFixed(2);
    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime; const orderId = r.headers.location?.split('/').pop();
        log('ORDER', `BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms | ${orderId}`);
        await notify(`BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms`, 'buy');
        return { success: true, orderId, latency };
    } catch (err) { log('ERROR', `BUY failed: ${err.response?.data?.message || err.message}`); return { success: false, error: err.response?.data?.message || err.message, latency: Date.now() - startTime }; }
}

async function placeSellOrder(ticker, quantity, reason, price) {
    const startTime = Date.now(); const session = getSessionType(); const orderType = getOrderType('MARKET', price);
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE',
        orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
    if (orderType === 'LIMIT' && price > 0) order.price = price.toFixed(2);
    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`);
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`, 'sell');
        return { success: true, latency };
    } catch (err) { log('ERROR', `SELL failed: ${err.response?.data?.message || err.message}`); return { success: false, error: err.response?.data?.message || err.message, latency: Date.now() - startTime }; }
}

async function placeBracketOrder(ticker, quantity, tpPrice, slPrice) {
    const startTime = Date.now(); const session = getSessionType();
    if (!isRegularHours()) { log('ORDER', 'Extended hours — bracket not supported, simple LIMIT'); return await placeBuyOrder(ticker, quantity, (tpPrice + slPrice) / 2); }
    const order = { orderType: 'MARKET', session, duration: 'DAY', orderStrategyType: 'TRIGGER',
        orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }],
        childOrderStrategies: [
            { orderType: 'LIMIT', session, duration: 'DAY', price: tpPrice.toFixed(2), orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] },
            { orderType: 'STOP', session, duration: 'DAY', stopPrice: slPrice.toFixed(2), orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] }
        ] };
    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime; const orderId = r.headers.location?.split('/').pop();
        log('ORDER', `BRACKET BUY ${quantity} ${ticker} TP:$${tpPrice.toFixed(2)} SL:$${slPrice.toFixed(2)} | ${latency}ms`);
        await notify(`BRACKET BUY ${quantity} ${ticker}\nTP:$${tpPrice.toFixed(2)} SL:$${slPrice.toFixed(2)} | ${latency}ms`, 'buy');
        return { success: true, orderId, latency };
    } catch (err) { log('ERROR', `BRACKET failed: ${err.response?.data?.message || err.message}`); log('WARN', 'Falling back to simple buy...'); return await placeBuyOrder(ticker, quantity, (tpPrice + slPrice) / 2); }
}

// ─── Orphan Safety ─────────────────────────────────────────────
async function checkOrphanPositions(positionsTracker) {
    if (!isAuthenticated() || !accountHash) return;
    try {
        const schwabPositions = await getPositionsFromSchwab();
        for (const pos of schwabPositions) {
            const symbol = pos.instrument?.symbol; const qty = pos.longQuantity || 0;
            if (!symbol || qty <= 0) continue;
            if (!positionsTracker.getPosition(symbol)) {
                const avgPrice = pos.averagePrice || 0;
                log('WARN', `ORPHAN: ${symbol} x${qty} @ $${avgPrice.toFixed(2)}`);
                await notify(`⚠️ ORPHAN: ${symbol} x${qty} @ $${avgPrice.toFixed(2)}\nAuto-close in ${process.env.ORPHAN_TIMEOUT_MINS || 5} mins.`, 'error');
                positionsTracker.openPosition(symbol, avgPrice, qty); positionsTracker.markOrphan(symbol);
            }
        }
    } catch (err) { log('DEBUG', `Orphan error: ${err.message}`); }
}

async function closeOrphanPositions(positionsTracker) {
    if (!isAuthenticated()) return;
    const timeoutMins = parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5');
    for (const orphan of positionsTracker.getOrphans(timeoutMins)) {
        log('WARN', `Auto-closing orphan: ${orphan.ticker} x${orphan.remainingQuantity}`);
        const result = await placeSellOrder(orphan.ticker, orphan.remainingQuantity, 'ORPHAN_AUTO_CLOSE', orphan.entryPrice);
        if (result.success) { positionsTracker.closePosition(orphan.ticker, orphan.entryPrice, 'ORPHAN_AUTO_CLOSE'); await notify(`🔴 AUTO-CLOSED: ${orphan.ticker} x${orphan.remainingQuantity}`, 'error'); }
    }
}

function startOrphanCheck(positionsTracker) {
    if (orphanCheckTimer) clearInterval(orphanCheckTimer);
    orphanCheckTimer = setInterval(async () => { await checkOrphanPositions(positionsTracker); await closeOrphanPositions(positionsTracker); }, 1 * 60 * 1000);
    log('INFO', 'Orphan checker started (every 1 min)');
}

async function cancelOrdersForTicker(ticker) {
    try {
        const r = await api.get(`/accounts/${getAccountId()}/orders`, { params: { status: 'QUEUED' } });
        let cancelled = 0;
        for (const order of (r.data || [])) { if (order.orderLegCollection?.[0]?.instrument?.symbol === ticker) { await api.delete(`/accounts/${getAccountId()}/orders/${order.orderId}`); cancelled++; } }
        if (cancelled > 0) log('ORDER', `Cancelled ${cancelled} orders for ${ticker}`);
        return cancelled;
    } catch (err) { log('DEBUG', `Cancel orders: ${err.response?.status || err.message}`); return 0; }
}

const schwabService = {
    getAuthUrl, exchangeCodeForTokens, refreshAccessToken, startTokenRefresh, isAuthenticated, getTokenStatus,
    placeBuyOrder, placeSellOrder, placeBracketOrder, getPositionsFromSchwab, cancelOrdersForTicker,
    getAccessToken, setAccountHash, getAccountHash, fetchAccountHash, getAccountId,
    isRegularHours, getSessionType, checkOrphanPositions, closeOrphanPositions, startOrphanCheck
};
module.exports = { schwabService };
