function log(level, message) {
    const timestamp = new Date().toISOString();
    setImmediate(() => console.log(`[${timestamp}] [${level}] ${message}`));
}
module.exports = { log };
