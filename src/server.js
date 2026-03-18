/**
 * MACD Momentum Webhook Server v1.2.2
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

app.use('/', healthRouter);
app.use('/auth', authRouter);
app.use('/debug', debugRouter);
app.use('/', webhookRouter);

app.listen(PORT, () => {
    log('INFO', `Server v1.2.2 started on port ${PORT}`);
    log('INFO', `Schwab client configured: ${process.env.SCHWAB_CLIENT_ID ? 'YES' : 'NO'}`);
    schwabService.startTokenRefresh();
    const { positions } = require('./services/positions');
    schwabService.startOrphanCheck(positions);
});
