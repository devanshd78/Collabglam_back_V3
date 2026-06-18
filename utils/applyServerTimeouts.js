'use strict';

function getTimeoutMs(options = {}) {
  const value = Number(
    process.env.SERVER_REQUEST_TIMEOUT_MS ||
      process.env.APP_REQUEST_TIMEOUT_MS ||
      options.timeoutMs ||
      360000
  );

  return Number.isFinite(value) && value > 0 ? value : 360000;
}

function applyServerTimeouts(server, options = {}) {
  if (!server) return server;

  const timeoutMs = getTimeoutMs(options);
  const headersTimeoutMs = Number(options.headersTimeoutMs || timeoutMs + 10000);
  const keepAliveTimeoutMs = Number(options.keepAliveTimeoutMs || timeoutMs + 5000);

  // Allow one long synchronous YouTube discovery request to complete while the
  // frontend loader remains visible.
  server.requestTimeout = timeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.timeout = timeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;

  return server;
}

module.exports = applyServerTimeouts;