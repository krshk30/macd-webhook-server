const express = require('express');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');
const router = express.Router();
router.get('/start', (req, res) => { log('AUTH', 'Redirecting...'); res.redirect(schwabService.getAuthUrl()); });
router.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No auth code');
    log('AUTH', 'Exchanging code...');
    if (!await schwabService.exchangeCodeForTokens(code)) return res.status(500).send('Auth Failed. <a href="/auth/start">Retry</a>');
    log('AUTH', 'Waiting 3s...'); await new Promise(r => setTimeout(r, 3000));
    const hash = await schwabService.fetchAccountHash();
    res.send(hash ? `<h2>✅ Success!</h2><p>Hash: ${hash.substring(0,10)}...</p><a href="/debug/schwab">Debug</a>` : `<h2>⚠️ Token OK, hash failed</h2><a href="/debug/schwab">Retry</a>`);
});
module.exports = { authRouter: router };
