/**
 * Auth Route — Schwab OAuth2 flow
 * /auth/start → redirects to Schwab login
 * /auth/callback → receives auth code, exchanges for tokens
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
        // Auto-fetch account hash after successful auth
        log('AUTH', 'Fetching account hash...');
        const hashResult = await schwabService.fetchAndStoreAccountHash();

        res.send(`
            <h2>Authentication Successful</h2>
            <p>Schwab API tokens obtained. Server is now ready to trade.</p>
            <p>Token status: ${schwabService.getTokenStatus()}</p>
            <p>Account hash: ${hashResult ? 'Found and stored automatically' : 'Failed to fetch (will retry on first trade)'}</p>
            <p><a href="/health">Check health status</a></p>
            <p><a href="/accounts">View account details</a></p>
        `);
    } else {
        res.status(500).send(`
            <h2>Authentication Failed</h2>
            <p>Could not exchange authorization code for tokens.</p>
            <p>Check server logs for details.</p>
            <p><a href="/auth/start">Try again</a></p>
        `);
    }
});

module.exports = { authRouter: router };
