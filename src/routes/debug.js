/**
 * Debug Route v1.2.2 — Schwab API Diagnostic
 */
const express = require('express');
const axios = require('axios');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');
const router = express.Router();

router.get('/schwab', async (req, res) => {
    const accessToken = schwabService.getAccessToken();
    if (!accessToken) return res.json({ diagnosis: '🔴 NO TOKEN', fix: 'Visit /auth/start', results: {} });

    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
    const results = {};

    log('INFO', 'Debug: Testing endpoints...');

    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/userPreference', { headers, timeout: 10000 }); results.userPreference = { status: r.status, ok: true }; }
    catch (err) { results.userPreference = { status: err.response?.status || 'ERROR', ok: false }; }

    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts/accountNumbers', { headers, timeout: 10000 }); results.accountNumbers = { status: r.status, ok: true, data: r.data }; }
    catch (err) { results.accountNumbers = { status: err.response?.status || 'ERROR', ok: false, error: err.response?.data || err.message }; }

    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts', { headers, timeout: 10000 }); results.accounts = { status: r.status, ok: true }; }
    catch (err) { results.accounts = { status: err.response?.status || 'ERROR', ok: false }; }

    try { const r = await axios.get('https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL&fields=quote', { headers, timeout: 10000 }); results.marketData = { status: r.status, ok: true }; }
    catch (err) { results.marketData = { status: err.response?.status || 'ERROR', ok: false }; }

    let diagnosis, fix;
    if (results.accountNumbers.ok) {
        const accounts = results.accountNumbers.data;
        if (Array.isArray(accounts) && accounts.length > 0) {
            schwabService.setAccountHash(accounts[0].hashValue);
            diagnosis = '✅ ALL WORKING — account hash saved';
            fix = `Account: ${accounts[0].accountNumber} → Hash: ${accounts[0].hashValue.substring(0, 10)}... Ready!`;
        } else { diagnosis = '⚠️ Empty array'; fix = 'Account not linked.'; }
    } else if (results.accountNumbers.status === 500 && results.marketData.ok) {
        diagnosis = '🔴 Market data works, accounts do not'; fix = 'Re-auth via /auth/start. CHECK brokerage account box.';
    } else if (results.userPreference.status === 401) {
        diagnosis = '🔴 Token invalid'; fix = '/auth/start for fresh token.';
    } else {
        diagnosis = `⚠️ accountNumbers returned ${results.accountNumbers.status}`; fix = 'Email traderapi@schwab.com';
    }

    log('INFO', `Debug: ${diagnosis}`);
    res.json({ timestamp: new Date().toISOString(), diagnosis, fix,
        accountHash: schwabService.getAccountHash()?.substring(0, 10) + '...' || null,
        tokenStatus: schwabService.getTokenStatus(), session: schwabService.getSessionType(), results });
});

module.exports = { debugRouter: router };
