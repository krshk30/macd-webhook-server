/**
 * Schwab Trader API Service v1.2
 * 
 * v1.2 CHANGES:
 *   - Extended hours: auto-detects pre/post market, uses LIMIT + SEAMLESS session
 *   - Orphan position safety: periodic sync checks for positions without matching tracker
 *   - TP/SL controlled by env vars (TP_CENTS, SL_CENTS)
 *   - Emergency stop: auto-closes orphan positions after configurable timeout
 */

const axios = require('axios');
const { log } = require('./logger');
const { notify } = require('./notifications');

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';

const https = require('https');
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

let tokens = {
    access_token: null,
    refresh_token: null,
    expires_at: 0,
    token_type: 'Bearer'
};

let accountHash = null;
let refreshTimer = null;
let orphanCheckTimer = null;

// ─── Axios instance with keep-alive ────────────────────────────
const api = axios.create({
    baseURL: SCHWAB_API_BASE,
    httpsAgent: keepAliveAgent,
    timeout: 5000,
    headers: { 'Content-Type': 'application/json' }
});

api.interceptors.request.use(config => {
    if (tokens.access_token) {
        config.headers.Authorization = `Bearer ${tokens.access_token}`;
    }
    return config;
});

// ─── Market Hours Detection ────────────────────────────────────

function getEasternTime() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isRegularHours() {
    const et = getEasternTime();
    const hour = et.getHours();
    const min = et.getMinutes();
    const totalMins = hour * 60 + min;
    // Regular market: 9:30 AM - 4:00 PM ET
    return totalMins >= 570 && totalMins < 960;
}

function getSessionType() {
    return isRegularHours() ? 'NORMAL' : 'SEAMLESS';
}

function getOrderType(requestedType, price) {
    if (isRegularHours()) {
        return requestedType; // MARKET is fine during regular hours
    }
    // Pre/post market: MUST use LIMIT orders
    if (requestedType === 'MARKET' && price && price > 0) {
        log('ORDER', `Extended hours detected — converting MARKET → LIMIT @ $${price.toFixed(2)}`);
        return 'LIMIT';
    }
    return requestedType;
}

// ─── OAuth2 Functions ──────────────────────────────────────────

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
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: authCode,
                redirect_uri: callbackUrl
            }).toString(),
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                httpsAgent: keepAliveAgent
            }
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
    if (!tokens.refresh_token) {
        log('WARN', 'No refresh token available — re-authentication required');
        return false;
    }

    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
        const response = await axios.post(SCHWAB_TOKEN_URL,
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token
            }).toString(),
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                httpsAgent: keepAliveAgent
            }
        );

        tokens.access_token = response.data.access_token;
        tokens.expires_at = Date.now() + (response.data.expires_in * 1000);
        if (response.data.refresh_token) {
            tokens.refresh_token = response.data.refresh_token;
        }

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
    refreshTimer = setInterval(async () => {
        log('INFO', 'Proactive token refresh...');
        await refreshAccessToken();
    }, 25 * 60 * 1000);
    log('INFO', 'Token auto-refresh timer started (every 25 min)');
}

function isAuthenticated() {
    return tokens.access_token && Date.now() < tokens.expires_at;
}

function getTokenStatus() {
    if (!tokens.access_token) return 'no_token';
    if (Date.now() >= tokens.expires_at) return 'expired';
    const minsLeft = Math.round((tokens.expires_at - Date.now()) / 60000);
    return `valid (${minsLeft}m remaining)`;
}

// ─── Account Hash Functions ────────────────────────────────────

function getAccessToken() { return tokens.access_token; }
function setAccountHash(hash) { accountHash = hash; log('INFO', `Account hash stored: ${hash.substring(0, 10)}...`); }
function getAccountHash() { return accountHash; }

async function fetchAccountHash() {
    if (!tokens.access_token) return null;
    try {
        const response = await api.get('/accounts/accountNumbers');
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            accountHash = response.data[0].hashValue;
            log('INFO', `Account hash fetched: ${response.data[0].accountNumber} → ${accountHash.substring(0, 10)}...`);
            return accountHash;
        }
    } catch (err) {
        log('ERROR', `Failed to fetch account hash: ${err.response?.status} — ${err.response?.data?.message || err.message}`);
    }
    return null;
}

function getAccountId() {
    if (accountHash) return accountHash;
    return process.env.SCHWAB_ACCOUNT_HASH || process.env.SCHWAB_ACCOUNT_ID;
}

// ─── Order Placement ───────────────────────────────────────────

/**
 * Place a buy order — auto-detects regular vs extended hours
 * Regular hours: MARKET order, NORMAL session
 * Extended hours: LIMIT order at current price, SEAMLESS session
 */
async function placeBuyOrder(ticker, quantity, price) {
    const startTime = Date.now();
    const session = getSessionType();
    const orderType = getOrderType('MARKET', price);

    const order = {
        orderType: orderType,
        session: session,
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        orderLegCollection: [{
            instruction: 'BUY',
            quantity: quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    // Add price for LIMIT orders (extended hours)
    if (orderType === 'LIMIT' && price > 0) {
        order.price = price.toFixed(2);
    }

    try {
        const response = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();
        log('ORDER', `BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms | Order: ${orderId}`);
        await notify(`BUY ${quantity} ${ticker} | ${orderType} ${session} | ${latency}ms`, 'buy');
        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `BUY order failed: ${errMsg} | ${latency}ms`);
        return { success: false, error: errMsg, latency };
    }
}

/**
 * Place a sell order — auto-detects session type
 */
async function placeSellOrder(ticker, quantity, reason = '', price) {
    const startTime = Date.now();
    const session = getSessionType();
    const orderType = getOrderType('MARKET', price);

    const order = {
        orderType: orderType,
        session: session,
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        orderLegCollection: [{
            instruction: 'SELL',
            quantity: quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }]
    };

    if (orderType === 'LIMIT' && price > 0) {
        order.price = price.toFixed(2);
    }

    try {
        const response = await api.post(`/accounts/${getAccountId()}/orders`, order);
        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();
        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`);
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${orderType} ${session} | ${latency}ms`, 'sell');
        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `SELL order failed: ${errMsg} | ${latency}ms`);
        return { success: false, error: errMsg, latency };
    }
}

/**
 * Place a bracket order: buy + take profit + stop loss
 * TP/SL controlled by TP_CENTS and SL_CENTS env vars
 * Extended hours: uses LIMIT + SEAMLESS for the entry
 */
async function placeBracketOrder(ticker, quantity, tpPrice, slPrice) {
    const startTime = Date.now();
    const session = getSessionType();

    // Entry order — LIMIT for extended hours, MARKET for regular
    const entryType = isRegularHours() ? 'MARKET' : 'LIMIT';

    const order = {
        orderType: entryType,
        session: session,
        duration: 'DAY',
        orderStrategyType: 'TRIGGER',
        orderLegCollection: [{
            instruction: 'BUY',
            quantity: quantity,
            instrument: { symbol: ticker, assetType: 'EQUITY' }
        }],
        childOrderStrategies: [
            {
                orderType: 'LIMIT',
                session: session,
                duration: 'DAY',
                price: tpPrice.toFixed(2),
                orderStrategyType: 'SINGLE',
                orderLegCollection: [{
                    instruction: 'SELL',
                    quantity: quantity,
                    instrument: { symbol: ticker, assetType: 'EQUITY' }
                }]
            },
            {
                orderType: 'STOP',
                session: session,
                duration: 'DAY',
                stopPrice: slPrice.toFixed(2),
                orderStrategyType: 'SINGLE',
                orderLegCollection: [{
                    instruction: 'SELL',
                    quantity: quantity,
                    instrument: { symbol: ticker, assetType: 'EQUITY' }
                }]
            }
        ]
    };

    // For extended hours LIMIT entry, add price
    if (entryType === 'LIMIT') {
        // Use midpoint between TP and SL as entry price (close to current)
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
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `BRACKET order failed: ${errMsg} | ${latency}ms`);
        log('WARN', 'Falling back to simple buy...');
        return await placeBuyOrder(ticker, quantity, (tpPrice + slPrice) / 2);
    }
}

// ─── Position Sync (Orphan Safety Net) ─────────────────────────

/**
 * Checks Schwab for real positions that the server doesn't know about.
 * This catches the "repainting" scenario where TV fires BUY, Schwab fills it,
 * then TV's signal disappears — leaving an orphan position with no exit.
 */
async function checkOrphanPositions(positionsTracker) {
    if (!isAuthenticated()) return;

    try {
        const response = await api.get(`/accounts/${getAccountId()}?fields=positions`);
        const schwabPositions = response.data?.securitiesAccount?.positions || [];

        for (const pos of schwabPositions) {
            const symbol = pos.instrument?.symbol;
            const qty = pos.longQuantity || 0;

            if (!symbol || qty <= 0) continue;

            // Check if our tracker knows about this position
            const tracked = positionsTracker.getPosition(symbol);

            if (!tracked) {
                // ORPHAN DETECTED — position exists on Schwab but not in our tracker
                const avgPrice = pos.averagePrice || 0;
                const currentPrice = pos.currentDayProfitLossPercentage != null
                    ? avgPrice * (1 + pos.currentDayProfitLossPercentage / 100)
                    : avgPrice;

                log('WARN', `⚠️ ORPHAN POSITION: ${symbol} x${qty} @ $${avgPrice.toFixed(2)} — not tracked by server`);
                await notify(
                    `⚠️ ORPHAN DETECTED: ${symbol} x${qty} @ $${avgPrice.toFixed(2)}\n` +
                    `This position exists on Schwab but has no matching signal tracker.\n` +
                    `Possible repainting or missed EXIT signal.\n` +
                    `Server will auto-close in ${process.env.ORPHAN_TIMEOUT_MINS || 5} minutes if not resolved.`,
                    'error'
                );

                // Auto-register it so we can track and eventually close it
                positionsTracker.openPosition(symbol, avgPrice, qty);
                positionsTracker.markOrphan(symbol);
            }
        }
    } catch (err) {
        log('ERROR', `Orphan check failed: ${err.message}`);
    }
}

/**
 * Close orphan positions that have been untracked for too long
 */
async function closeOrphanPositions(positionsTracker) {
    if (!isAuthenticated()) return;

    const timeoutMins = parseInt(process.env.ORPHAN_TIMEOUT_MINS || '5');
    const orphans = positionsTracker.getOrphans(timeoutMins);

    for (const orphan of orphans) {
        log('WARN', `Auto-closing orphan: ${orphan.ticker} x${orphan.remainingQuantity}`);

        const currentPrice = orphan.entryPrice; // best we have
        const result = await placeSellOrder(
            orphan.ticker,
            orphan.remainingQuantity,
            'ORPHAN_AUTO_CLOSE',
            currentPrice
        );

        if (result.success) {
            positionsTracker.closePosition(orphan.ticker, currentPrice, 'ORPHAN_AUTO_CLOSE');
            await notify(
                `🔴 AUTO-CLOSED ORPHAN: ${orphan.ticker} x${orphan.remainingQuantity}\n` +
                `Reason: No exit signal received within ${timeoutMins} minutes.`,
                'error'
            );
        }
    }
}

function startOrphanCheck(positionsTracker) {
    if (orphanCheckTimer) clearInterval(orphanCheckTimer);

    // Check every 2 minutes
    orphanCheckTimer = setInterval(async () => {
        await checkOrphanPositions(positionsTracker);
        await closeOrphanPositions(positionsTracker);
    }, 2 * 60 * 1000);

    log('INFO', 'Orphan position checker started (every 2 min)');
}

// ─── Existing helper functions ─────────────────────────────────

async function getPositions() {
    try {
        const response = await api.get(`/accounts/${getAccountId()}?fields=positions`);
        return response.data?.securitiesAccount?.positions || [];
    } catch (err) {
        log('ERROR', `Get positions failed: ${err.message}`);
        return [];
    }
}

async function cancelOrdersForTicker(ticker) {
    try {
        const response = await api.get(`/accounts/${getAccountId()}/orders`, {
            params: { status: 'QUEUED' }
        });
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

// ─── Module Exports ────────────────────────────────────────────

const schwabService = {
    getAuthUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    startTokenRefresh,
    isAuthenticated,
    getTokenStatus,
    placeBuyOrder,
    placeSellOrder,
    placeBracketOrder,
    getPositions,
    cancelOrdersForTicker,
    getAccessToken,
    setAccountHash,
    getAccountHash,
    fetchAccountHash,
    getAccountId,
    // v1.2
    isRegularHours,
    getSessionType,
    checkOrphanPositions,
    closeOrphanPositions,
    startOrphanCheck
};

module.exports = { schwabService };
