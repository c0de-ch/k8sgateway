/** Entrypoint: config -> verifier -> Apollo -> Express -> listen, with graceful shutdown. */
import http from 'node:http';
import { createVerifier } from './auth.js';
import { createApolloServer, createExpressApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createOrderStore } from './orders.js';

const cfg = loadConfig();
const logger = createLogger(cfg.logLevel);
const verifier = createVerifier(cfg, { logger });
const orders = createOrderStore();

// The http.Server is created first so Apollo's drain plugin can close it on stop().
const httpServer = http.createServer();
const apollo = createApolloServer({ cfg, orders, logger, httpServer });
await apollo.start();

let shuttingDown = false;
httpServer.on('request', createExpressApp({ cfg, apollo, verifier, logger, isReady: () => !shuttingDown && verifier.state().ready }));

verifier.start(); // discovery in the background — startup never blocks on the IdP
await new Promise<void>((resolve) => httpServer.listen(cfg.port, resolve));
logger.info('graphql-api listening', {
  port: cfg.port,
  issuer: cfg.issuer,
  issuerClaim: cfg.issuerClaim,
  jwksUri: cfg.jwksUri ?? '(from discovery)',
  audience: cfg.audience,
  rolesClaim: cfg.rolesClaim,
  corsOrigins: cfg.corsOrigins,
  restApiInternalUrl: cfg.restApiInternalUrl,
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true; // /readyz -> 503 so the endpoint controller stops routing new requests to us
  logger.info('shutting down', { signal, drainDelayMs: cfg.shutdownDelayMs });
  verifier.stop();
  setTimeout(() => {
    logger.warn('forced exit after timeout');
    process.exit(1);
  }, 15_000).unref();
  await new Promise((resolve) => setTimeout(resolve, cfg.shutdownDelayMs));
  await apollo.stop(); // drains in-flight requests and closes the http server
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
