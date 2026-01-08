function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${timestamp()}][Moisa]`, ...args);
}

function logWarn(...args) {
  console.warn(`[${timestamp()}][Moisa][WARN]`, ...args);
}

function logError(...args) {
  console.error(`[${timestamp()}][Moisa][ERROR]`, ...args);
}

module.exports = {
  log,
  logWarn,
  logError
};
