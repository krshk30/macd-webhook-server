const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const router = express.Router();
const startedAt = new Date().toISOString();
router.get('/health', (req, res) => {
    res.status(schwabService.isAuthenticated() ? 200 : 503).json({
        status: 'ok', version: '1.2.5', uptime: process.uptime().toFixed(0) + 's', startedAt,
        schwab: { authenticated: schwabService.isAuthenticated(), tokenStatus: schwabService.getTokenStatus(), accountHash: schwabService.getAccountHash() ? 'available' : 'not_fetched', session: schwabService.getSessionType() },
        trading: positions.getStatus(),
        config: { defaultQuantity: process.env.DEFAULT_QUANTITY || '10', tradingHours: `${process.env.TRADING_START_HOUR || '7'}:00-${process.env.TRADING_END_HOUR || '18'}:00 ET`, orphanTimeout: (process.env.ORPHAN_TIMEOUT_MINS || '5') + ' mins' }
    });
});
router.get('/positions', (req, res) => res.json(positions.getStatus()));
router.get('/', (req, res) => res.json({ service: 'MACD Momentum Webhook', version: '1.2.5' }));
module.exports = { healthRouter: router };
