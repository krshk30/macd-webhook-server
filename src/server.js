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
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '10kb' }));

// TradingView can occasionally deliver a JSON-looking payload as text/plain.
// Parse it here so a missing parsed body does not get misreported as auth failure.
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/webhook' && typeof req.body === 'string') {
        try {
            req.body = JSON.parse(req.body);
        } catch (err) {
            log('ERROR', 'Plain-text webhook body was not valid JSON', {
                ip: req.ip,
                contentType: req.headers['content-type'],
                bodyPreview: req.body.substring(0, 200)
            });
            return res.status(400).json({ error: 'invalid JSON' });
        }
    }
    next();
});

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
    schwabService.startPendingEntryMonitor(positions);
    schwabService.startPendingCloseMonitor(positions);
    schwabService.startFloorMonitor(positions);
});
