/**
 * PATCH: Add this to your Railway server
 * 
 * This file contains TWO things to add to your existing server:
 * 
 * 1. A /debug/schwab diagnostic route (add to server.js)
 * 2. Updated auth callback that auto-fetches account hash
 * 
 * ═══════════════════════════════════════════════════════════════
 * INSTRUCTIONS — READ CAREFULLY
 * ═══════════════════════════════════════════════════════════════
 * 
 * STEP 1: RE-AUTHENTICATE (most likely fix)
 * ──────────────────────────────────────────
 * Your token was probably created before the app was "Ready For Use".
 * Even though the token looks valid, it doesn't carry account permissions.
 * 
 *   → Visit: https://your-app.up.railway.app/auth/start
 *   → Log in with your BROKERAGE credentials (not developer portal)
 *   → When prompted, SELECT your brokerage account checkbox
 *   → Complete the flow
 *   → Then test: https://your-app.up.railway.app/debug/schwab
 * 
 * STEP 2: ADD THE CODE BELOW TO YOUR SERVER
 * ──────────────────────────────────────────
 * This adds:
 *   - /debug/schwab endpoint to test all Schwab API endpoints
 *   - Auto-fetch account hash after successful OAuth
 *   - Account hash stored in memory and used for orders
 * 
 * ═══════════════════════════════════════════════════════════════
 */


// ─── ADD TO: src/routes/health.js (or create src/routes/debug.js) ───
// Then add: app.use('/debug', debugRouter); in server.js

const express = require('express');
const axios = require('axios');
const debugRouter = express.Router();

const SCHWAB_API_BASE = 'https://api.schwabapi.com/trader/v1';
const SCHWAB_MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

/**
 * GET /debug/schwab
 * Tests all critical Schwab API endpoints and shows exactly what's working
 */
debugRouter.get('/schwab', async (req, res) => {
    // Import your token storage - adjust path to match your project
    // const { schwabService } = require('../services/schwab');
    
    // For now, we'll read the token from wherever your server stores it.
    // Replace this with however your server accesses the current access token:
    const accessToken = getAccessToken(); // ← REPLACE with your token getter
    
    if (!accessToken) {
        return res.json({
            error: 'No access token available',
            fix: 'Visit /auth/start to authenticate first'
        });
    }

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
    };

    const results = {};

    // Test 1: User Preferences (basic token validation)
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/userPreference`, { headers, timeout: 10000 });
        results.userPreference = { status: r.status, data: 'OK' };
    } catch (err) {
        results.userPreference = { 
            status: err.response?.status || 'ERROR', 
            data: err.response?.data || err.message 
        };
    }

    // Test 2: Account Numbers (the problematic endpoint)
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts/accountNumbers`, { headers, timeout: 10000 });
        results.accountNumbers = { status: r.status, data: r.data };
    } catch (err) {
        results.accountNumbers = { 
            status: err.response?.status || 'ERROR', 
            data: err.response?.data || err.message 
        };
    }

    // Test 3: Accounts list
    try {
        const r = await axios.get(`${SCHWAB_API_BASE}/accounts`, { headers, timeout: 10000 });
        results.accounts = { status: r.status, data: 'OK — returned account data' };
    } catch (err) {
        results.accounts = { 
            status: err.response?.status || 'ERROR', 
            data: err.response?.data || err.message 
        };
    }

    // Test 4: Market data (non-account endpoint)
    try {
        const r = await axios.get(`${SCHWAB_MARKET_BASE}/quotes?symbols=AAPL&fields=quote`, { headers, timeout: 10000 });
        results.marketData = { status: r.status, data: 'OK — got AAPL quote' };
    } catch (err) {
        results.marketData = { 
            status: err.response?.status || 'ERROR', 
            data: err.response?.data || err.message 
        };
    }

    // Diagnosis
    let diagnosis = '';
    let fix = '';

    if (results.accountNumbers.status === 200) {
        diagnosis = '✅ ALL WORKING — account hash available';
        fix = 'No fix needed! Account hash: ' + JSON.stringify(results.accountNumbers.data);
    } else if (results.accountNumbers.status === 500 && results.marketData.status === 200) {
        diagnosis = '🔴 Token works for market data but NOT accounts';
        fix = 'Re-authenticate: visit /auth/start. Your token was likely created before app approval. During Schwab login, make sure you SELECT your brokerage account.';
    } else if (results.accountNumbers.status === 500 && results.userPreference.status !== 200) {
        diagnosis = '🔴 Token appears invalid for all trading endpoints';
        fix = 'Re-authenticate: visit /auth/start with a completely fresh login.';
    } else if (results.accountNumbers.status === 403) {
        diagnosis = '🔴 App lacks Accounts & Trading permission';
        fix = 'Check developer.schwab.com — ensure "Accounts and Trading Production" is enabled on your app.';
    } else {
        diagnosis = `⚠️ Unexpected state — accountNumbers returned ${results.accountNumbers.status}`;
        fix = 'Email traderapi@schwab.com with the full output below.';
    }

    res.json({
        timestamp: new Date().toISOString(),
        diagnosis,
        fix,
        results
    });
});

module.exports = { debugRouter };


// ═══════════════════════════════════════════════════════════════
// ADD TO: src/services/schwab.js — after exchangeCodeForTokens()
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch and cache the account hash after successful authentication.
 * The account hash is required for all order placement calls.
 * 
 * Add this function to your schwab service, and call it
 * right after exchangeCodeForTokens() succeeds in your auth callback.
 */
async function fetchAccountHash() {
    try {
        const response = await axios.get(
            `${SCHWAB_API_BASE}/accounts/accountNumbers`,
            {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Accept': 'application/json'
                },
                timeout: 10000
            }
        );

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            const accountHash = response.data[0].hashValue;
            const accountNumber = response.data[0].accountNumber;
            
            // Store in memory for order placement
            // Replace process.env with your preferred storage
            process.env.SCHWAB_ACCOUNT_HASH = accountHash;
            
            console.log(`✅ Account hash fetched: ${accountNumber} → ${accountHash.substring(0, 8)}...`);
            return accountHash;
        } else {
            console.error('❌ No accounts returned from accountNumbers endpoint');
            return null;
        }
    } catch (err) {
        console.error(`❌ Failed to fetch account hash: ${err.response?.status} — ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// UPDATE: src/routes/auth.js — in the /auth/callback handler
// ═══════════════════════════════════════════════════════════════

/**
 * Replace your existing /auth/callback route with this version.
 * The key change: after token exchange, it immediately tries to 
 * fetch the account hash and reports the result.
 */

/*
authRouter.get('/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('Missing authorization code');
    }

    try {
        const success = await schwabService.exchangeCodeForTokens(code);
        
        if (success) {
            // NEW: Auto-fetch account hash right after getting tokens
            const accountHash = await schwabService.fetchAccountHash();
            
            if (accountHash) {
                res.send(`
                    <h1>✅ Authentication Successful!</h1>
                    <p><strong>Token:</strong> Valid</p>
                    <p><strong>Account Hash:</strong> ${accountHash.substring(0, 8)}...</p>
                    <p>Your server is now ready to place orders.</p>
                    <p>Visit <a href="/health">/health</a> to verify status.</p>
                    <p>Visit <a href="/debug/schwab">/debug/schwab</a> to test all endpoints.</p>
                `);
            } else {
                res.send(`
                    <h1>⚠️ Authenticated, but account hash failed</h1>
                    <p><strong>Token:</strong> Valid</p>
                    <p><strong>Account Hash:</strong> FAILED — /accounts/accountNumbers returned an error</p>
                    <hr>
                    <h3>Troubleshooting:</h3>
                    <ol>
                        <li>Visit <a href="/debug/schwab">/debug/schwab</a> to see which endpoints work</li>
                        <li>Make sure your app is "Ready For Use" on developer.schwab.com</li>
                        <li>Try re-authenticating — visit <a href="/auth/start">/auth/start</a></li>
                        <li>During Schwab login, ensure you CHECK the brokerage account box</li>
                    </ol>
                `);
            }
        } else {
            res.status(500).send('Token exchange failed — check server logs');
        }
    } catch (err) {
        res.status(500).send(`Auth error: ${err.message}`);
    }
});
*/


// ═══════════════════════════════════════════════════════════════
// UPDATE: Order placement — use account HASH, not account NUMBER
// ═══════════════════════════════════════════════════════════════

/**
 * IMPORTANT: Schwab API does NOT accept raw account numbers for orders.
 * You must use the HASH value from /accounts/accountNumbers.
 * 
 * In your placeBuyOrder / placeSellOrder functions, change:
 *   `/accounts/${process.env.SCHWAB_ACCOUNT_ID}/orders`
 * To:
 *   `/accounts/${process.env.SCHWAB_ACCOUNT_HASH}/orders`
 * 
 * The hash is auto-populated after successful authentication 
 * (see fetchAccountHash above).
 */
