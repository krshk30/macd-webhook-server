const axios = require('axios');
const { log } = require('./logger');
const { notify } = require('./notifications');
const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';
const https = require('https');
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };
let accountHash = null, refreshTimer = null, orphanCheckTimer = null, heartbeatTimer = null;
const api = axios.create({ baseURL: SCHWAB_API_BASE, httpsAgent: keepAliveAgent, timeout: 5000, headers: { 'Content-Type': 'application/json' } });
api.interceptors.request.use(c => { if (tokens.access_token) c.headers.Authorization = `Bearer ${tokens.access_token}`; return c; });

function getEasternTime() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function isRegularHours() { const et = getEasternTime(); const m = et.getHours() * 60 + et.getMinutes(); return m >= 570 && m < 960; }
function getSessionType() { return isRegularHours() ? 'NORMAL' : 'SEAMLESS'; }
function getLimitBuffer() { return parseFloat(process.env.LIMIT_BUFFER_CENTS || '0.02'); }
function getOrderType(req, price) { if (isRegularHours()) return req; if (req === 'MARKET' && price > 0) { log('ORDER', 'Ext hours — MARKET → LIMIT'); return 'LIMIT'; } return req; }

function getAuthUrl() { return `${SCHWAB_AUTH_URL}?response_type=code&client_id=${process.env.SCHWAB_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.SCHWAB_CALLBACK_URL)}`; }
async function exchangeCodeForTokens(code) {
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try { const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.SCHWAB_CALLBACK_URL }).toString(), { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + (r.data.expires_in * 1000) };
        log('INFO', 'OAuth tokens obtained'); startTokenRefresh(); return true;
    } catch (e) { log('ERROR', `Token exchange: ${e.response?.data?.error || e.message}`); return false; }
}
async function refreshAccessToken() {
    if (!tokens.refresh_token) return false;
    const auth = Buffer.from(`${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`).toString('base64');
    try { const r = await axios.post(SCHWAB_TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(), { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: keepAliveAgent });
        tokens.access_token = r.data.access_token; tokens.expires_at = Date.now() + (r.data.expires_in * 1000);
        if (r.data.refresh_token) tokens.refresh_token = r.data.refresh_token;
        log('INFO', `Token refreshed ${r.data.expires_in}s`); return true;
    } catch (e) { log('ERROR', `Token refresh: ${e.message}`); await notify('TOKEN REFRESH FAILED', 'error'); return false; }
}
function startTokenRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = setInterval(async () => { log('INFO', 'Token refresh...'); await refreshAccessToken(); }, 25 * 60 * 1000); log('INFO', 'Token refresh started (25 min)'); }
function isAuthenticated() { return tokens.access_token && Date.now() < tokens.expires_at; }
function getTokenStatus() { if (!tokens.access_token) return 'no_token'; if (Date.now() >= tokens.expires_at) return 'expired'; return `valid (${Math.round((tokens.expires_at - Date.now()) / 60000)}m)`; }
function getAccessToken() { return tokens.access_token; }
function setAccountHash(h) { accountHash = h; log('INFO', `Hash stored: ${h.substring(0,10)}...`); }
function getAccountHash() { return accountHash; }
async function fetchAccountHash() {
    if (!tokens.access_token) return null;
    for (let i = 1; i <= 2; i++) { try { const r = await api.get('/accounts/accountNumbers'); if (r.data?.length > 0) { accountHash = r.data[0].hashValue; log('INFO', `Hash: ${r.data[0].accountNumber} → ${accountHash.substring(0,10)}...`); return accountHash; } } catch (e) { log('WARN', `Hash attempt ${i}: ${e.response?.status}`); if (i < 2) await new Promise(r => setTimeout(r, 3000)); } }
    log('ERROR', 'Hash failed — /debug/schwab'); return null;
}
function getAccountId() { return accountHash || process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID; }

async function getPositionsFromSchwab() {
    try { const r = await axios.get(`${SCHWAB_API_BASE}/accounts`, { headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' }, httpsAgent: keepAliveAgent, timeout: 10000 });
        const acct = (r.data || []).find(a => a.securitiesAccount) || r.data?.[0] || {};
        return acct?.securitiesAccount?.positions || [];
    } catch (e) { log('DEBUG', `Positions: ${e.response?.status || e.message}`); return []; }
}

async function placeBuyOrder(ticker, quantity, price) {
    const t0 = Date.now(), session = getSessionType(), orderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();
    const limitPrice = orderType === 'LIMIT' && price > 0 ? price + buffer : price;
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'BUY', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
    if (orderType === 'LIMIT' && limitPrice > 0) { order.price = limitPrice.toFixed(2); log('ORDER', `BUY LIMIT @ $${limitPrice.toFixed(2)} (signal: $${price.toFixed(2)} + $${buffer} buffer)`); }
    try { const r = await api.post(`/accounts/${getAccountId()}/orders`, order); const lat = Date.now() - t0, oid = r.headers.location?.split('/').pop();
        log('ORDER', `BUY ${quantity} ${ticker} | ${orderType} ${session} | ${lat}ms | ${oid}`); await notify(`BUY ${quantity} ${ticker} | ${orderType} ${session} | ${lat}ms`, 'buy');
        return { success: true, orderId: oid, latency: lat };
    } catch (e) { log('ERROR', `BUY failed: ${e.response?.data?.message || e.message}`); return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 }; }
}

async function placeSellOrder(ticker, quantity, reason, price) {
    const t0 = Date.now(), session = getSessionType(), orderType = getOrderType('MARKET', price);
    const buffer = getLimitBuffer();
    const limitPrice = orderType === 'LIMIT' && price > 0 ? price - buffer : price;
    const order = { orderType, session, duration: 'DAY', orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity, instrument: { symbol: ticker, assetType: 'EQUITY' } }] };
    if (orderType === 'LIMIT' && limitPrice > 0) { order.price = limitPrice.toFixed(2); log('ORDER', `SELL LIMIT @ $${limitPrice.toFixed(2)} (signal: $${price.toFixed(2)} - $${buffer} buffer)`); }
    try { const r = await api.post(`/accounts/${getAccountId()}/orders`, order); const lat = Date.now() - t0;
        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${lat}ms`); await notify(`SELL ${quantity} ${ticker} (${reason}) | ${lat}ms`, 'sell');
        return { success: true, latency: lat };
    } catch (e) { log('ERROR', `SELL failed: ${e.response?.data?.message || e.message}`); return { success: false, error: e.response?.data?.message || e.message, latency: Date.now() - t0 }; }
}

async function cancelOrdersForTicker(ticker) {
    try { const now = new Date(), todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts/${getAccountId()}/orders`, { headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' }, params: { fromEnteredTime: todayStart, toEnteredTime: now.toISOString() }, httpsAgent: keepAliveAgent, timeout: 10000 });
        let cancelled = 0;
        for (const o of (r.data || [])) { const leg = o.orderLegCollection?.[0], st = o.status;
            if (leg?.instrument?.symbol === ticker && ['WORKING','QUEUED','ACCEPTED','PENDING_ACTIVATION'].includes(st)) {
                try { await api.delete(`/accounts/${getAccountId()}/orders/${o.orderId}`); cancelled++; log('ORDER', `Cancelled ${o.orderId} (${st}) for ${ticker}`); } catch (e) { log('WARN', `Cancel ${o.orderId}: ${e.response?.status}`); } } }
        if (cancelled > 0) log('ORDER', `Cancelled ${cancelled} orders for ${ticker}`);
        else log('DEBUG', `No cancelable orders for ${ticker}`);
        return cancelled;
    } catch (e) { log('WARN', `Cancel orders: ${e.response?.status || e.message}`); return 0; }
}

async function checkOrphanPositions(pt) {
    if (!isAuthenticated() || !accountHash) return;
    try { const schwab = await getPositionsFromSchwab();
        for (const p of schwab) { const sym = p.instrument?.symbol, qty = p.longQuantity || 0;
            if (!sym || qty <= 0) continue;
            if (!pt.getPosition(sym)) { const avg = p.averagePrice || 0; log('WARN', `ORPHAN: ${sym} x${qty} @ $${avg.toFixed(2)}`); await notify(`⚠️ ORPHAN: ${sym} x${qty}`, 'error'); pt.openPosition(sym, avg, qty); pt.markOrphan(sym); } }
    } catch (e) { log('DEBUG', `Orphan: ${e.message}`); }
}
async function closeOrphanPositions(pt) {
    if (!isAuthenticated()) return;
    for (const o of pt.getOrphans(parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5'))) {
        log('WARN', `Auto-closing orphan: ${o.ticker} x${o.remainingQuantity}`);
        const r = await placeSellOrder(o.ticker, o.remainingQuantity, 'ORPHAN_AUTO_CLOSE', o.entryPrice);
        if (r.success) { pt.closePosition(o.ticker, o.entryPrice, 'ORPHAN_AUTO_CLOSE'); await notify(`🔴 AUTO-CLOSED orphan: ${o.ticker}`, 'error'); }
    }
}

// v1.2.8: Heartbeat checker — closes positions where Pine went silent
async function checkHeartbeats(pt) {
    if (!isAuthenticated()) return;
    const timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_SECS || '90');
    const expired = pt.getHeartbeatExpired(timeout);
    for (const pos of expired) {
        const age = Math.round((Date.now() - pos.lastSignalTime) / 1000);
        log('WARN', `💔 HEARTBEAT EXPIRED: ${pos.ticker} — no signal for ${age}s (limit: ${timeout}s)`);
        await cancelOrdersForTicker(pos.ticker);
        const result = await placeSellOrder(pos.ticker, pos.remainingQuantity, 'HEARTBEAT_EXPIRED', pos.entryPrice);
        if (result.success) {
            const summary = pt.closePosition(pos.ticker, pos.entryPrice, 'HEARTBEAT_EXPIRED');
            await notify(`💔 HEARTBEAT EXPIRED: ${pos.ticker} x${summary.remainingClosed}\nNo signal for ${age}s — BUY likely repainted\nP&L: $${summary.pnl.toFixed(2)}`, 'error');
        }
    }
}

function startOrphanCheck(pt) { if (orphanCheckTimer) clearInterval(orphanCheckTimer); orphanCheckTimer = setInterval(async () => { await checkOrphanPositions(pt); await closeOrphanPositions(pt); }, 60 * 1000); log('INFO', 'Orphan checker started (1 min)'); }

// v1.2.8: Heartbeat checker runs every 30 seconds
function startHeartbeatCheck(pt) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => { await checkHeartbeats(pt); }, 30 * 1000);
    log('INFO', `Heartbeat checker started (every 30s, timeout: ${process.env.HEARTBEAT_TIMEOUT_SECS || '90'}s)`);
}

module.exports = { schwabService: { getAuthUrl, exchangeCodeForTokens, refreshAccessToken, startTokenRefresh, isAuthenticated, getTokenStatus, placeBuyOrder, placeSellOrder, getPositionsFromSchwab, cancelOrdersForTicker, getAccessToken, setAccountHash, getAccountHash, fetchAccountHash, getAccountId, isRegularHours, getSessionType, checkOrphanPositions, closeOrphanPositions, startOrphanCheck, checkHeartbeats, startHeartbeatCheck } };
