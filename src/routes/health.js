const express = require('express');
const { schwabService } = require('../services/schwab');
const { positions } = require('../services/positions');
const router = express.Router();
router.get('/health', (req, res) => { res.status(schwabService.isAuthenticated() ? 200 : 503).json({ status: 'ok', version: '1.2.7', uptime: process.uptime().toFixed(0) + 's', schwab: { authenticated: schwabService.isAuthenticated(), tokenStatus: schwabService.getTokenStatus(), session: schwabService.getSessionType() }, trading: positions.getStatus() }); });
router.get('/positions', (req, res) => res.json(positions.getStatus()));
router.get('/', (req, res) => res.json({ service: 'MACD Momentum Webhook', version: '1.2.7' }));
module.exports = { healthRouter: router };
