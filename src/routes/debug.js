/**
 * Debug Route — Schwab API Diagnostic
 * Tests all Schwab endpoints and reports what's working
 */

const express = require('express');
const axios = require('axios');
const { schwabService } = require('../services/schwab');
const { log } = require('../services/logger');

const router = express.Router();

router.get('/schwab', async (req, res) => {
    const accessToken = schwabService.getAccessToken();

    if (!accessToken) {
        return res.json({
            timestamp: new Date().toISOString(),
            diagnosis: '🔴 NO TOKEN — authenticate first',
            fix: 'Visit /auth/start to login with your Schwab brokerage credentials',
            results: {}
        });
    }

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
    };

    const results = {};

    log('INFO', 'Debug: Testing userPreference...');
    try {
        const r = await axios.get('https://api.schwabapi.com/trader/v1/userPreference', { headers, timeout: 10000 });
        results.userPreference = { status: r.status, ok: true };
    } catch (err) {
        results.userPreference = { status: err.response?.status || 'ERROR', ok: false, error: err.response?.data || err.message };
    }

    log('INFO', 'Debug: Testing accounts/accountNumbers...');
    try {
        const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts/accountNumbers', { headers, timeout: 10000 });
        results.accountNumbers = { status: r.status, ok: true, data: r.data };
    } catch (err) {
        results.accountNumbers = { status: err.response?.status || 'ERROR', ok: false, error: err.response?.data || err.message };
    }

    log('INFO', 'Debug: Testing accounts...');
    try {
        const r = await axios.get('https://api.schwabapi.com/trader/v1/accounts', { headers, timeout: 10000 });
        results.accounts = { status: r.status, ok: true };
    } catch (err) {
        results.accounts = { status: err.response?.status || 'ERROR', ok: false, error: err.response?.data || err.message };
    }

    log('INFO', 'Debug: Testing market data...');
    try {
        const r = await axios.get('https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL&fields=quote', { headers, timeout: 10000 });
        results.marketData = { status: r.status, ok: true };
    } catch (err) {
        results.marketData = { status: err.response?.status || 'ERROR', ok: false, error: err.response?.data || err.message };
    }

    let diagnosis = '';
    let fix = '';

    if (results.accountNumbers.ok) {
        const accounts = results.accountNumbers.data;
        if (Array.isArray(accounts) && accounts.length > 0) {
            const hash = accounts[0].hashValue;
            schwabService.setAccountHash(hash);
            diagnosis = '✅ ALL WORKING — account hash saved automatically';
            fix = `Account: ${accounts[0].accountNumber} → Hash: ${hash.substring(0, 10)}... Server is ready to place orders!`;
        } else {
            diagnosis = '⚠️ accountNumbers returned empty array';
            fix = 'Your Schwab account may not be linked. Check developer.schwab.com app settings.';
        }
    } else if (results.accountNumbers.status === 500 && results.marketData.ok) {
        diagnosis = '🔴 Market data works but accounts do NOT';
        fix = 'Visit /auth/start to re-authenticate. CHECK the brokerage account box during login.';
    } else if (results.userPreference.status === 401) {
        diagnosis = '🔴 Token is invalid or expired';
        fix = 'Visit /auth/start to get a fresh token.';
    } else if (results.accountNumbers.status === 403) {
        diagnosis = '🔴 App lacks Accounts & Trading permission';
        fix = 'On developer.schwab.com, edit app and enable "Accounts and Trading Production".';
    } else {
        diagnosis = `⚠️ Unexpected — accountNumbers returned ${results.accountNumbers.status}`;
        fix = 'Email traderapi@schwab.com with this output.';
    }

    log('INFO', `Debug result: ${diagnosis}`);

    res.json({
        timestamp: new Date().toISOString(),
        diagnosis, fix,
        accountHash: schwabService.getAccountHash() ? schwabService.getAccountHash().substring(0, 10) + '...' : null,
        tokenStatus: schwabService.getTokenStatus(),
        session: schwabService.getSessionType(),
        results
    });
});

module.exports = { debugRouter: router };
