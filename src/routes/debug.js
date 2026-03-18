const express = require('express');
const axios = require('axios');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');
const router = express.Router();
router.get('/schwab', async (req, res) => {
    const t = schwabService.getAccessToken();
    if (!t) return res.json({ diagnosis: 'NO TOKEN', fix: '/auth/start' });
    const h = { 'Authorization': `Bearer ${t}`, 'Accept': 'application/json' };
    const results = {};
    log('INFO', 'Debug: Testing...');
    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/userPreference', { headers: h, timeout: 10000 }); results.userPreference = { status: r.status, ok: true }; } catch (e) { results.userPreference = { status: e.response?.status || 'ERR', ok: false }; }
    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts/accountNumbers', { headers: h, timeout: 10000 }); results.accountNumbers = { status: r.status, ok: true, data: r.data }; } catch (e) { results.accountNumbers = { status: e.response?.status || 'ERR', ok: false, error: e.response?.data || e.message }; }
    try { const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts', { headers: h, timeout: 10000 }); results.accounts = { status: r.status, ok: true }; } catch (e) { results.accounts = { status: e.response?.status || 'ERR', ok: false }; }
    try { const r = await axios.get('https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL&fields=quote', { headers: h, timeout: 10000 }); results.marketData = { status: r.status, ok: true }; } catch (e) { results.marketData = { status: e.response?.status || 'ERR', ok: false }; }
    let diagnosis, fix;
    if (results.accountNumbers.ok && results.accountNumbers.data?.length > 0) {
        schwabService.setAccountHash(results.accountNumbers.data[0].hashValue);
        diagnosis = '✅ ALL WORKING'; fix = `Account: ${results.accountNumbers.data[0].accountNumber} → Hash: ${results.accountNumbers.data[0].hashValue.substring(0, 10)}... Ready!`;
    } else if (results.accountNumbers.status === 500 && results.marketData.ok) { diagnosis = '🔴 Accounts fail'; fix = 'Re-auth /auth/start'; }
    else if (results.userPreference.status === 401) { diagnosis = '🔴 Token invalid'; fix = '/auth/start'; }
    else { diagnosis = `⚠️ accountNumbers: ${results.accountNumbers.status}`; fix = 'Email traderapi@schwab.com'; }
    log('INFO', `Debug: ${diagnosis}`);
    res.json({ timestamp: new Date().toISOString(), diagnosis, fix, accountHash: schwabService.getAccountHash()?.substring(0, 10) + '...' || null, tokenStatus: schwabService.getTokenStatus(), session: schwabService.getSessionType(), results });
});
module.exports = { debugRouter: router };
