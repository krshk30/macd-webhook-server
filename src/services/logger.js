function log(level, message) { const ts = new Date().toISOString(); setImmediate(() => console.log(`[${ts}] [${level}] ${message}`)); }
module.exports = { log };
