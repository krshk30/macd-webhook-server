/**
 * Auth Route — Schwab OAuth2 flow (v1.1)
 * /auth/start → redirects to Schwab login
 * /auth/callback → receives auth code, exchanges for tokens, auto-fetches account hash
 */

const express = require('express');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');

const router = express.Router();

// Step 1: Redirect user to Schwab login
router.get('/start', (req, res) => {
    const authUrl = schwabService.getAuthUrl();
    log('AUTH', 'Redirecting to Schwab OAuth login...');
    res.redirect(authUrl);
});

// Step 2: Schwab redirects back with auth code
router.get('/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        log('ERROR', 'OAuth callback: no code received');
        return res.status(400).send('No authorization code received. Please try /auth/start again.');
    }

    log('AUTH', 'Received auth code, exchanging for tokens...');
    const success = await schwabService.exchangeCodeForTokens(code);

    if (success) {
        // v1.1: Auto-fetch account hash right after getting tokens
        log('AUTH', 'Tokens obtained, fetching account hash...');
        const accountHash = await schwabService.fetchAccountHash();

        if (accountHash) {
            res.send(`
                <h2>✅ Authentication Successful!</h2>
                <p><strong>Token:</strong> ${schwabService.getTokenStatus()}</p>
                <p><strong>Account Hash:</strong> ${accountHash.substring(0, 10)}...</p>
                <p>Your server is now ready to place orders.</p>
                <hr>
                <p><a href="/health">Check health status</a></p>
                <p><a href="/debug/schwab">Run full API diagnostic</a></p>
            `);
        } else {
            res.send(`
                <h2>⚠️ Authenticated, but account hash failed</h2>
                <p><strong>Token:</strong> ${schwabService.getTokenStatus()}</p>
                <p><strong>Account Hash:</strong> FAILED</p>
                <p>The /accounts/accountNumbers endpoint returned an error.</p>
                <hr>
                <h3>Troubleshooting:</h3>
                <ol>
                    <li>Visit <a href="/debug/schwab">/debug/schwab</a> to see which endpoints work</li>
                    <li>Make sure your app is "Ready For Use" on developer.schwab.com</li>
                    <li>Try re-authenticating — <a href="/auth/start">/auth/start</a></li>
                    <li>During Schwab login, ensure you CHECK the brokerage account box</li>
                </ol>
            `);
        }
    } else {
        res.status(500).send(`
            <h2>❌ Authentication Failed</h2>
            <p>Could not exchange authorization code for tokens.</p>
            <p>Check server logs for details.</p>
            <p><a href="/auth/start">Try again</a></p>
        `);
    }
});

module.exports = { authRouter: router };
