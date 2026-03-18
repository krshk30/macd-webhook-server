/**
 * Health Route v1.2.2
 */
const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const router = express.Router();
const startedAt = new Date().toISOString();

router.get('/health', (req, res) => {
    res.status(schwabService.isAuthenticated() ? 200 : 503).json({
        status: 'ok', version: '1.2.2', uptime: process.uptime().toFixed(0) + 's', startedAt,
        schwab: {
            authenticated: schwabService.isAuthenticated(),
            tokenStatus: schwabService.getTokenStatus(),
            accountHash: schwabService.getAccountHash() ? 'available' : 'not_fetched',
            session: schwabService.getSessionType()
        },
        trading: positions.getStatus(),
        config: {
            defaultQuantity: process.env.DEFAULT_QUANTITY || '1000',
            tpCents: process.env.TP_CENTS || '0.08',
            slCents: process.env.SL_CENTS || '0.05',
            tradingHours: `${process.env.TRADING_START_HOUR || '7'}:00-${process.env.TRADING_END_HOUR || '18'}:00 ET`,
            orphanTimeout: (process.env.ORPHAN_TIMEOUT_MINS || '5') + ' mins'
        }
    });
});

router.get('/positions', (req, res) => res.json(positions.getStatus()));

router.get('/', (req, res) => {
    res.json({ service: 'MACD Momentum Webhook Server', version: '1.2.2',
        endpoints: { health: '/health', webhook: 'POST /webhook', auth: '/auth/start', positions: '/positions', debug: '/debug/schwab' }
    });
});

module.exports = { healthRouter: router };
