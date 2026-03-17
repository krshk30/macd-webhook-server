/**
 * MACD Momentum Webhook Server v1.2.1
 * TradingView alerts → Schwab Trader API → TOS execution
 */

require('dotenv').config();
const express = require('express');
const { webhookRouter } = require('./routes/webhook');
const { authRouter } = require('./routes/auth');
const { healthRouter } = require('./routes/health');
const { debugRouter } = require('./routes/debug');
const { schwabService } = require('./services/schwab');
const { log } = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

// Routes
app.use('/', healthRouter);
app.use('/auth', authRouter);
app.use('/debug', debugRouter);
app.use('/', webhookRouter);

// Start server
app.listen(PORT, () => {
    log('INFO', `Server v1.2.1 started on port ${PORT}`);
    log('INFO', `Environment: ${process.env.NODE_ENV || 'development'}`);
    log('INFO', `Schwab client configured: ${process.env.SCHWAB_CLIENT_ID ? 'YES' : 'NO'}`);

    schwabService.startTokenRefresh();

    // Start orphan position checker (catches repainting signals)
    const { positions } = require('./services/positions');
    schwabService.startOrphanCheck(positions);
});
