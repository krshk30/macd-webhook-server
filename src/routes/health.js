/**
 * Health Route — server status, token validity, positions
 */

const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');

const router = express.Router();
const startedAt = new Date().toISOString();

router.get('/health', (req, res) => {
    const status = {
        status: 'ok',
        uptime: process.uptime().toFixed(0) + 's',
        startedAt,
        schwab: {
            authenticated: schwabService.isAuthenticated(),
            tokenStatus: schwabService.getTokenStatus(),
            accountId: process.env.SCHWAB_ACCOUNT_ID ? 'configured' : 'missing'
        },
        trading: positions.getStatus(),
        config: {
            dryRun: (process.env.DRY_RUN || 'true') === 'true',
            defaultQuantity: process.env.DEFAULT_QUANTITY || '1000',
            emergencySlPct: (process.env.EMERGENCY_SL_PCT || '5') + '%',
            exitStrategy: 'TV scaled exits (2%/4%) + emergency SL safety net',
            tradingHours: `${process.env.TRADING_START_HOUR || '7'}:00 - ${process.env.TRADING_END_HOUR || '16'}:00`
        }
    };

    const httpStatus = schwabService.isAuthenticated() ? 200 : 503;
    res.status(httpStatus).json(status);
});

router.get('/positions', (req, res) => {
    res.json(positions.getStatus());
});

// Get Schwab encrypted account hashes
router.get('/accounts', async (req, res) => {
    const accounts = await schwabService.getAccountHash();
    if (accounts) {
        res.json({
            message: 'Copy the hashValue for your account and set it as SCHWAB_ACCOUNT_ID in Railway',
            accounts
        });
    } else {
        res.status(500).json({ error: 'Failed to fetch accounts. Check authentication.' });
    }
});

// Simple root response
router.get('/', (req, res) => {
    res.json({
        service: 'MACD Momentum Webhook Server',
        version: '1.0.0',
        endpoints: {
            health: 'GET /health',
            webhook: 'POST /webhook',
            auth: 'GET /auth/start',
            positions: 'GET /positions'
        }
    });
});

module.exports = { healthRouter: router };
