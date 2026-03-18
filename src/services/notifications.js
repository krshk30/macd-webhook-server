const axios = require('axios');
const { log } = require('./logger');
const COLORS = { buy: 0x00ff00, sell: 0xff6600, profit: 0x00ff00, loss: 0xff0000, error: 0xff0000, info: 0x3399ff };
async function notify(message, type = 'info') {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    setImmediate(async () => {
        try {
            await axios.post(webhookUrl, {
                embeds: [{ title: 'MACD Momentum', description: message, color: COLORS[type] || COLORS.info,
                    timestamp: new Date().toISOString(), footer: { text: 'v1.2.4' } }]
            }, { timeout: 3000 });
        } catch (err) { log('WARN', `Discord failed: ${err.message}`); }
    });
}
module.exports = { notify };
