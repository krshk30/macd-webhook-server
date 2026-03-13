/**
 * Logger — async, structured, never blocks the order path
 */

function log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;

    // Async write — never blocks
    setImmediate(() => console.log(line));
}

module.exports = { log };
