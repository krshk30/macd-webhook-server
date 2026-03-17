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
        version: '1.2.1',
        uptime: process.uptime().toFixed(0) + 's',
        startedAt,
        schwab: {
            authenticated: schwabService.isAuthenticated(),
            tokenStatus: schwabService.getTokenStatus(),
            accountId: process.env.SCHWAB_ACCOUNT_ID ? 'configured' : 'missing',
            accountHash: schwabService.getAccountHash() ? 'available' : 'not_fetched',
            session: schwabService.getSessionType()
        },
        trading: positions.getStatus(),
        config: {
            defaultQuantity: process.env.DEFAULT_QUANTITY || '1000',
            tpCents: process.env.TP_CENTS || '0.08',
            slCents: process.env.SL_CENTS || '0.05',
            tradingHours: `${process.env.TRADING_START_HOUR || '7'}:00 - ${process.env.TRADING_END_HOUR || '18'}:00 ET`,
            orphanTimeout: (process.env.ORPHAN_TIMEOUT_MINS || '5') + ' mins'
        }
    };

    const httpStatus = schwabService.isAuthenticated() ? 200 : 503;
    res.status(httpStatus).json(status);
});

router.get('/positions', (req, res) => {
    res.json(positions.getStatus());
});

router.get('/', (req, res) => {
    res.json({
        service: 'MACD Momentum Webhook Server',
        version: '1.2.1',
        endpoints: {
            health: 'GET /health',
            webhook: 'POST /webhook',
            auth: 'GET /auth/start',
            positions: 'GET /positions',
            debug: 'GET /debug/schwab'
        }
    });
});

module.exports = { healthRouter: router };
