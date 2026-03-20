const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const { getDailySummary, getRecentLogs } = require('../services/logger');
const router = express.Router();

router.get('/health', (req, res) => {
    res.status(schwabService.isAuthenticated() ? 200 : 503).json({
        status: 'ok',
        version: '1.3.0',
        uptime: process.uptime().toFixed(0) + 's',
        schwab: {
            authenticated: schwabService.isAuthenticated(),
            tokenStatus: schwabService.getTokenStatus(),
            session: schwabService.getSessionType()
        },
        trading: positions.getStatus(),
        heartbeat: { timeout: (process.env.HEARTBEAT_TIMEOUT_SECS || '60') + 's' }
    });
});

router.get('/positions', (req, res) => res.json(positions.getStatus()));

// v1.3.0: Daily trade summary
router.get('/summary', (req, res) => {
    const date = req.query.date || undefined; // YYYY-MM-DD or today
    res.json(getDailySummary(date));
});

// v1.3.0: Recent logs (last N entries)
router.get('/logs', (req, res) => {
    const n = parseInt(req.query.n) || 50;
    res.json(getRecentLogs(n));
});

router.get('/', (req, res) => res.json({ service: 'MACD Momentum Webhook', version: '1.3.0' }));

module.exports = { healthRouter: router };
