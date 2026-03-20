const axios = require('axios');
const { log } = require('./logger');
const C = { buy: 0x00ff00, sell: 0xff6600, profit: 0x00ff00, loss: 0xff0000, error: 0xff0000, info: 0x3399ff };

async function notify(msg, type = 'info') {
    const u = process.env.DISCORD_WEBHOOK_URL;
    if (!u) return;
    setImmediate(async () => {
        try {
            await axios.post(u, {
                embeds: [{
                    title: 'MACD Momentum',
                    description: msg,
                    color: C[type] || C.info,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'v1.3.0' }
                }]
            }, { timeout: 3000 });
        } catch (e) { log('WARN', `Discord failed: ${e.message}`); }
    });
}

module.exports = { notify };
