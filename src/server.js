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

// Catch JSON parse errors — log what was received
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        log('ERROR', 'JSON parse failed on webhook', {
            ip: req.ip,
            contentType: req.headers['content-type'],
            bodyPreview: err.body ? err.body.substring(0, 200) : 'empty'
        });
        return res.status(400).json({ error: 'invalid JSON' });
    }
    next(err);
});

app.set('trust proxy', 1);

app.use('/', healthRouter);
app.use('/auth', authRouter);
app.use('/debug', debugRouter);
app.use('/', webhookRouter);

app.listen(PORT, () => {
    log('INFO', `Server v1.3.0 started on port ${PORT}`);
    schwabService.startTokenRefresh();
    const { positions } = require('./services/positions');
    schwabService.startOrphanCheck(positions);
    schwabService.startHeartbeatCheck(positions);
    schwabService.startFloorMonitor(positions);
});
