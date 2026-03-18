const express = require('express');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');
const router = express.Router();
router.get('/start', (req, res) => { log('AUTH', 'Redirecting...'); res.redirect(schwabService.getAuthUrl()); });
router.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No auth code. Try /auth/start');
    log('AUTH', 'Exchanging code...');
    const success = await schwabService.exchangeCodeForTokens(code);
    if (!success) return res.status(500).send('<h2>Auth Failed</h2><a href="/auth/start">Retry</a>');
    log('AUTH', 'Waiting 3s for hash...'); await new Promise(r => setTimeout(r, 3000));
    const hash = await schwabService.fetchAccountHash();
    if (hash) res.send(`<h2>✅ Success!</h2><p>Token: ${schwabService.getTokenStatus()}</p><p>Hash: ${hash.substring(0, 10)}...</p><a href="/debug/schwab">Debug</a>`);
    else res.send(`<h2>⚠️ Token OK, hash failed</h2><a href="/debug/schwab">Click to retry</a>`);
});
module.exports = { authRouter: router };
