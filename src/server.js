/**
 * MACD Momentum Webhook Server
 * Receives TradingView alerts → places orders via Schwab Trader API
 * Optimized for <500ms end-to-end latency
 */

require('dotenv').config();
const express = require('express');
const { webhookRouter } = require('./routes/webhook');
const { authRouter } = require('./routes/auth');
const { healthRouter } = require('./routes/health');
const { schwabService } = require('./services/schwab');
const { log } = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// JSON parsing — keep payload limit small for speed
app.use(express.json({ limit: '10kb' }));

// Trust Railway proxy for accurate IP logging
app.set('trust proxy', 1);

// Routes
app.use('/', healthRouter);
app.use('/auth', authRouter);
app.use('/', webhookRouter);

// Start server
app.listen(PORT, () => {
    log('INFO', `Server started on port ${PORT}`);
    log('INFO', `Environment: ${process.env.NODE_ENV || 'development'}`);
    log('INFO', `Schwab client configured: ${process.env.SCHWAB_CLIENT_ID ? 'YES' : 'NO'}`);

    // Start token refresh timer if we have tokens
    schwabService.startTokenRefresh();
});
