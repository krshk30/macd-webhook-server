/**
 * Auth Route v1.2.2 — 3s delay before hash fetch
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');
const router = express.Router();

router.get('/start', (req, res) => {
    log('AUTH', 'Redirecting to Schwab OAuth login...');
    res.redirect(schwabService.getAuthUrl());
});

router.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) { log('ERROR', 'No code received'); return res.status(400).send('No auth code. Try /auth/start again.'); }

    log('AUTH', 'Received auth code, exchanging for tokens...');
    const success = await schwabService.exchangeCodeForTokens(code);

    if (success) {
        log('AUTH', 'Tokens obtained, waiting 3s before fetching account hash...');
        await new Promise(r => setTimeout(r, 3000));
        const hash = await schwabService.fetchAccountHash();

        if (hash) {
            res.send(`<h2>✅ Authentication Successful!</h2>
                <p><b>Token:</b> ${schwabService.getTokenStatus()}</p>
                <p><b>Account Hash:</b> ${hash.substring(0, 10)}...</p>
                <p>Server is ready to place orders.</p>
                <p><a href="/health">/health</a> | <a href="/debug/schwab">/debug/schwab</a></p>`);
        } else {
            res.send(`<h2>⚠️ Authenticated, but account hash failed</h2>
                <p><b>Token:</b> ${schwabService.getTokenStatus()}</p>
                <p>Click <a href="/debug/schwab">/debug/schwab</a> to fetch it now (usually works on retry).</p>`);
        }
    } else {
        res.status(500).send(`<h2>❌ Auth Failed</h2><p>Check logs. <a href="/auth/start">Try again</a></p>`);
    }
});

module.exports = { authRouter: router };
