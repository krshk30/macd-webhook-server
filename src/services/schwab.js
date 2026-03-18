/**
 * Schwab Trader API Service v1.2.5
 *
 * SCHWAB API QUIRKS (DO NOT CHANGE):
 * 1.  /accounts/{hash}?fields=positions → 400
 * 2.  /accounts?fields=positions → 400
 * 3.  /accounts (no params, raw axios) → 200
 * 4.  getPositionsFromSchwab MUST use raw axios with Accept header
 * 5.  Bracket (TRIGGER) fails with SEAMLESS → skip in ext hours
 * 6.  Fresh tokens need 3s before account endpoints work
 * 7.  All time checks use Eastern, not UTC
 * 8.  Position failures log at DEBUG level
 * 9.  api instance sends Content-Type on GETs → Schwab rejects
 * 10. cancelOrdersForTicker MUST use raw axios + date range (not status filter)
 * 11. Bracket child orders are WORKING/ACCEPTED, not QUEUED
 * 12. No bracket orders — causes orphan TP/SL that interfere with SCALE exits
 *
 * v1.2.5: No brackets, CANCEL_BUY handler, fixed cancelOrdersForTicker
 * v1.2.4: handleClose zero-qty guard
 * v1.2.3: 1-min orphan, raw axios positions
 * v1.2.2: /accounts for positions
 * v1.2.1: fetchAccountHash retry
 * v1.2: Extended hours LIMIT, orphan safety
 * v1.1: Account hash, /debug/schwab
 * v1.0: OAuth2, token refresh, orders
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

// API instance for POST orders (Content-Type OK for POST)
const api = axios.create({ baseURL: SCHWAB_API_BASE, httpsAgent: keepAliveAgent, timeout: 5000, headers: { 'Content-Type': 'application/json' } });
api.interceptors.request.use(config => { if (tokens.access_token) config.headers.Authorization = `Bearer ${tokens.access_token}`; return config; });

// ─── Market Hours ──────────────────────────────────────────────
function getEasternTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function isRegularHours() { const et = getEasternTime(); const m = et.getHours() * 60 + et.getMinutes(); return m >= 570 && m < 960; }
function getSessionType() { return isRegularHours() ? 'NORMAL' : 'SEAMLESS'; }
function getOrderType(requested, price) {
    if (isRegularHours()) return requested;
    if (requested === 'MARKET' && price && price > 0) { log('ORDER', `Extended hours — MARKET → LIMIT @ $${price.toFixed(2)}`); return 'LIMIT'; }
    return requested;
}

// ─── OAuth2 ────────────────────────────────────────────────────
function getAuthUrl() { return `${SCHWAB_AUTH_URL}?response_type=code&client_id=${process.env.SCHWAB_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SCHWAB_CALLBACK_URL)}`; }

async function exchangeCodeForTokens(authCode) {
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: process.env.SCHWAB_CALLBACK_URL }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + (r.data.expires_in * 1000), token_type: r.data.token_type || 'Bearer' };
        log('INFO', 'OAuth tokens obtained'); startTokenRefresh(); return true;
    } catch (err) { log('ERROR', `Token exchange: ${err.response?.data?.error || err.message}`); return false; }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) { log('WARN', 'No refresh token'); return false; }
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try {
        const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
            { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens.access_token = r.data.access_token; tokens.expires_at = Date.now() + (r.data.expires_in * 1000);
        if (r.data.refresh_token) tokens.refresh_token = r.data.refresh_token;
        log('INFO', `Token refreshed ${r.data.expires_in}s`); return true;
    } catch (err) { log('ERROR', `Token refresh: ${err.response?.data?.error || err.message}`); await notify('TOKEN REFRESH FAILED', 'error'); return false; }
}

function startTokenRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = setInterval(async () => { log('INFO', 'Token refresh...'); await refreshAccessToken(); }, 25 * 60 * 1000); log('INFO', 'Token refresh started (25 min)'); }
function isAuthenticated() { return tokens.access_token && Date.now() < tokens.expires_at; }
function getTokenStatus() { if (!tokens.access_token) return 'no_token'; if (Date.now() >= tokens.expires_at) return 'expired'; return `valid (${Math.round((tokens.expires_at - Date.now()) / 60000)}m remaining)`; }

// ─── Account Hash ──────────────────────────────────────────────
function getAccessToken() { return tokens.access_token; }
function setAccountHash(hash) { accountHash = hash; log('INFO', `Hash stored: ${hash.substring(0, 10)}...`); }
function getAccountHash() { return accountHash; }
async function fetchAccountHash() {
    if (!tokens.access_token) return null;
    for (let i = 1; i <= 2; i++) {
        try { const r = await api.get('/accounts/accountNumbers'); if (r.data?.length > 0) { accountHash = r.data[0].hashValue; log('INFO', `Hash: ${r.data[0].accountNumber} → ${accountHash.substring(0, 10)}...`); return accountHash; } }
        catch (err) { log('WARN', `Hash attempt ${i}: ${err.response?.status}`); if (i < 2) await new Promise(r => setTimeout(r, 3000)); }
    }
    log('ERROR', 'Hash failed — /debug/schwab'); return null;
}
function getAccountId() { return accountHash || process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID; }

// ─── Positions (raw axios — NOT api instance) ──────────────────
async function getPositionsFromSchwab() {
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts`, { headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' }, httpsAgent: keepAliveAgent, timeout: 10000 });
        const acct = (r.data || []).find(a => a.securitiesAccount) || r.data?.[0] || {};
        return acct?.securitiesAccount?.positions || [];
    } catch (err) { log('DEBUG', `Positions: ${err.response?.status || err.message}`); return []; }
}

// ─── Order Placement (v1.2.5: NO brackets — simple orders only) ─

async function placeBuyOrder(ticker, quantity, price) {
    const startTime = Date.now(); const session = getSessionType(); const orderType = getOrderType('MARKET', price);
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
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
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
    if (orderType === 'LIMIT' && price > 0) order.price = price.toFixed(2);
    try {
        const r = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`);
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`, 'sell');
        return { success: true, latency };
    } catch (err) { log('ERROR', `SELL failed: ${err.response?.data?.message || err.message}`); return { success: false, error: err.response?.data?.message || err.message, latency: Date.now() - startTime }; }
}

// ─── Cancel Orders (v1.2.5: raw axios, date range, all statuses) ─

async function cancelOrdersForTicker(ticker) {
    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const response = await axios.get(`${SCHWAB_API_BASE}/accounts/${getAccountId()}/orders`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
            params: { fromEnteredTime: todayStart, toEnteredTime: now.toISOString() },
            httpsAgent: keepAliveAgent, timeout: 10000
        });
        const orders = response.data || [];
        let cancelled = 0;
        for (const order of orders) {
            const leg = order.orderLegCollection?.[0];
            const status = order.status;
            const cancelable = ['WORKING', 'QUEUED', 'ACCEPTED', 'PENDING_ACTIVATION'].includes(status);
            if (leg?.instrument?.symbol === ticker && cancelable) {
                try { await api.delete(`/accounts/${getAccountId()}/orders/${order.orderId}`); cancelled++; log('ORDER', `Cancelled ${order.orderId} (${status}) for ${ticker}`); }
                catch (e) { log('WARN', `Cancel ${order.orderId} failed: ${e.response?.status}`); }
            }
        }
        if (cancelled > 0) log('ORDER', `Cancelled ${cancelled} orders for ${ticker}`);
        else log('DEBUG', `No cancelable orders for ${ticker}`);
        return cancelled;
    } catch (err) { log('WARN', `Cancel orders: ${err.response?.status || err.message}`); return 0; }
}

// ─── Orphan Safety ─────────────────────────────────────────────
async function checkOrphanPositions(pt) {
    if (!isAuthenticated() || !accountHash) return;
    try {
        const schwab = await getPositionsFromSchwab();
        for (const pos of schwab) {
            const sym = pos.instrument?.symbol, qty = pos.longQuantity || 0;
            if (!sym || qty <= 0) continue;
            if (!pt.getPosition(sym)) {
                const avg = pos.averagePrice || 0;
                log('WARN', `ORPHAN: ${sym} x${qty} @ $${avg.toFixed(2)}`);
                await notify(`⚠️ ORPHAN: ${sym} x${qty} @ $${avg.toFixed(2)}`, 'error');
                pt.openPosition(sym, avg, qty); pt.markOrphan(sym);
            }
        }
    } catch (err) { log('DEBUG', `Orphan: ${err.message}`); }
}

async function closeOrphanPositions(pt) {
    if (!isAuthenticated()) return;
    const mins = parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5');
    for (const o of pt.getOrphans(mins)) {
        log('WARN', `Auto-closing orphan: ${o.ticker} x${o.remainingQuantity}`);
        const r = await placeSellOrder(o.ticker, o.remainingQuantity, 'ORPHAN_AUTO_CLOSE', o.entryPrice);
        if (r.success) { pt.closePosition(o.ticker, o.entryPrice, 'ORPHAN_AUTO_CLOSE'); await notify(`🔴 AUTO-CLOSED: ${o.ticker} x${o.remainingQuantity}`, 'error'); }
    }
}

function startOrphanCheck(pt) {
    if (orphanCheckTimer) clearInterval(orphanCheckTimer);
    orphanCheckTimer = setInterval(async () => { await checkOrphanPositions(pt); await closeOrphanPositions(pt); }, 60 * 1000);
    log('INFO', 'Orphan checker started (1 min)');
}

const schwabService = {
    getAuthUrl, exchangeCodeForTokens, refreshAccessToken, startTokenRefresh, isAuthenticated, getTokenStatus,
    placeBuyOrder, placeSellOrder, getPositionsFromSchwab, cancelOrdersForTicker,
    getAccessToken, setAccountHash, getAccountHash, fetchAccountHash, getAccountId,
    isRegularHours, getSessionType, checkOrphanPositions, closeOrphanPositions, startOrphanCheck
};
module.exports = { schwabService };
