/**
 * Schwab Trader API Service
 * Handles OAuth2 authentication, token refresh, and order placement
 * Pre-authenticated tokens + HTTP keep-alive for minimum latency
 */

const axios = require('axios');
const { log } = require('./logger');
const { notify } = require('./notifications');

const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';

// Persistent HTTP agent for keep-alive connections (saves ~80ms per request)
const http = require('http');
const https = require('https');
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Token storage (in-memory — no database latency)
let tokens = {
    access_token: null,
    refresh_token: null,
    expires_at: 0,
    token_type: 'Bearer'
};

let refreshTimer = null;

// ─── Axios instance with keep-alive ────────────────────────────
const api = axios.create({
    baseURL: SCHWAB_API_BASE,
    httpsAgent: keepAliveAgent,
    timeout: 5000,  // 5s timeout — fail fast
    headers: { 'Content-Type': 'application/json' }
});

// Attach auth token to every request
api.interceptors.request.use(config => {
    if (tokens.access_token) {
        config.headers.Authorization = `Bearer ${tokens.access_token}`;
    }
    return config;
});

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
        // Schwab may return a new refresh token
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

    // Refresh every 25 minutes (tokens expire at 30 min)
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

// ─── Order Placement ───────────────────────────────────────────

const accountId = () => process.env.SCHWAB_ACCOUNT_ID;

/**
 * Place a market buy order with optional bracket (TP/SL)
 */
async function placeBuyOrder(ticker, quantity) {
    const startTime = Date.now();

    const order = {
        orderType: 'MARKET',
        session: 'NORMAL',
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        orderLegCollection: [{
            instruction: 'BUY',
            quantity: quantity,
            instrument: {
                symbol: ticker,
                assetType: 'EQUITY'
            }
        }]
    };

    try {
        const response = await api.post(
            `/accounts/${accountId()}/orders`,
            order
        );

        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();

        log('ORDER', `BUY ${quantity} ${ticker} | Order ID: ${orderId} | Latency: ${latency}ms`);
        await notify(`BUY ${quantity} ${ticker} @ market | ${latency}ms`, 'buy');

        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `BUY order failed: ${errMsg} | Latency: ${latency}ms`);
        await notify(`BUY FAILED: ${ticker} — ${errMsg}`, 'error');
        return { success: false, error: errMsg, latency };
    }
}

/**
 * Place a market sell order (for scaling out or closing)
 */
async function placeSellOrder(ticker, quantity, reason) {
    const startTime = Date.now();

    const order = {
        orderType: 'MARKET',
        session: 'NORMAL',
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        orderLegCollection: [{
            instruction: 'SELL',
            quantity: quantity,
            instrument: {
                symbol: ticker,
                assetType: 'EQUITY'
            }
        }]
    };

    try {
        const response = await api.post(
            `/accounts/${accountId()}/orders`,
            order
        );

        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();

        log('ORDER', `SELL ${quantity} ${ticker} (${reason}) | Order ID: ${orderId} | Latency: ${latency}ms`);
        await notify(`SELL ${quantity} ${ticker} (${reason}) | ${latency}ms`, 'sell');

        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `SELL order failed: ${errMsg} | Latency: ${latency}ms`);
        await notify(`SELL FAILED: ${ticker} — ${errMsg}`, 'error');
        return { success: false, error: errMsg, latency };
    }
}

/**
 * Place a bracket order (buy + OTO stop-loss + take-profit)
 */
async function placeBracketOrder(ticker, quantity, tpPrice, slPrice) {
    const startTime = Date.now();

    const order = {
        orderType: 'MARKET',
        session: 'NORMAL',
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
                session: 'NORMAL',
                duration: 'GOOD_TILL_CANCEL',
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
                session: 'NORMAL',
                duration: 'GOOD_TILL_CANCEL',
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

    try {
        const response = await api.post(
            `/accounts/${accountId()}/orders`,
            order
        );

        const latency = Date.now() - startTime;
        const orderId = response.headers.location?.split('/').pop();

        log('ORDER', `BRACKET BUY ${quantity} ${ticker} TP:$${tpPrice.toFixed(2)} SL:$${slPrice.toFixed(2)} | ${latency}ms`);
        await notify(`BRACKET BUY ${quantity} ${ticker}\nTP: $${tpPrice.toFixed(2)} | SL: $${slPrice.toFixed(2)} | ${latency}ms`, 'buy');

        return { success: true, orderId, latency };
    } catch (err) {
        const latency = Date.now() - startTime;
        const errMsg = err.response?.data?.message || err.message;
        log('ERROR', `BRACKET order failed: ${errMsg} | Latency: ${latency}ms`);

        // Fallback: try simple market buy if bracket fails
        log('WARN', 'Falling back to simple market buy...');
        return await placeBuyOrder(ticker, quantity);
    }
}

/**
 * Get current positions from Schwab
 */
async function getPositions() {
    try {
        const response = await api.get(`/accounts/${accountId()}?fields=positions`);
        return response.data?.securitiesAccount?.positions || [];
    } catch (err) {
        log('ERROR', `Get positions failed: ${err.message}`);
        return [];
    }
}

/**
 * Cancel all open orders for a ticker
 */
async function cancelOrdersForTicker(ticker) {
    try {
        const response = await api.get(`/accounts/${accountId()}/orders`, {
            params: { status: 'QUEUED' }
        });

        const orders = response.data || [];
        let cancelled = 0;

        for (const order of orders) {
            const leg = order.orderLegCollection?.[0];
            if (leg?.instrument?.symbol === ticker) {
                await api.delete(`/accounts/${accountId()}/orders/${order.orderId}`);
                cancelled++;
            }
        }

        if (cancelled > 0) {
            log('ORDER', `Cancelled ${cancelled} open orders for ${ticker}`);
        }
        return cancelled;
    } catch (err) {
        log('ERROR', `Cancel orders failed: ${err.message}`);
        return 0;
    }
}

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
    cancelOrdersForTicker
};

module.exports = { schwabService };
