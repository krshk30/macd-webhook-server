/**
 * Logger — async, structured, never blocks the order path
 */
function log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    setImmediate(() => console.log(line));
}

module.exports = { log };
