/**
 * Auth Route — Schwab OAuth2 flow v1.2.1
 * Adds 3-second delay before account hash fetch (fixes 400 on fresh tokens)
 */

const express = require('express');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');

const router = express.Router();

router.get('/start', (req, res) => {
    const authUrl = schwabService.getAuthUrl();
    log('AUTH', 'Redirecting to Schwab OAuth login...');
    res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        log('ERROR', 'OAuth callback: no code received');
        return res.status(400).send('No authorization code received. Please try /auth/start again.');
    }

    log('AUTH', 'Received auth code, exchanging for tokens...');
    const success = await schwabService.exchangeCodeForTokens(code);

    if (success) {
        // Wait 3 seconds — Schwab needs time to activate fresh tokens
        log('AUTH', 'Tokens obtained, waiting 3s before fetching account hash...');
        await new Promise(r => setTimeout(r, 3000));

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
                <p><strong>Account Hash:</strong> FAILED — will retry automatically</p>
                <p>Click <a href="/debug/schwab">/debug/schwab</a> to fetch it now (usually works on second try).</p>
                <hr>
                <h3>If /debug/schwab also fails:</h3>
                <ol>
                    <li>Make sure app is "Ready For Use" on developer.schwab.com</li>
                    <li>Try re-authenticating — <a href="/auth/start">/auth/start</a></li>
                    <li>During Schwab login, CHECK the brokerage account box</li>
                </ol>
            `);
        }
    } else {
        res.status(500).send(`
            <h2>❌ Authentication Failed</h2>
            <p>Could not exchange authorization code for tokens. Check server logs.</p>
            <p><a href="/auth/start">Try again</a></p>
        `);
    }
});

module.exports = { authRouter: router };
