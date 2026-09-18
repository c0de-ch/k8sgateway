/**
 * Wiring: Apollo Server (schema + resolvers + plugins) and the Express app (CORS, health, /graphql).
 * Kept separate from server.ts so the tests can build the same objects without listening on a port.
 */
import type http from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors, { type CorsOptions } from 'cors';
import { ApolloServer, type ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { expressMiddleware } from '@as-integrations/express5';
import { GraphQLError } from 'graphql';
import { AuthError, type Verifier } from './auth.js';
import type { Config } from './config.js';
import { silentLogger, type Logger } from './log.js';
import type { OrderStore } from './orders.js';
import { createResolvers, type Context } from './resolvers.js';
import { typeDefs } from './schema.js';

export interface ApolloDeps {
  cfg: Config;
  orders: OrderStore;
  logger?: Logger;
  /** When given, Apollo drains this server on stop() (graceful shutdown). */
  httpServer?: http.Server;
  fetchImpl?: typeof fetch;
}

/** RFC 6750 §3 challenge: error="invalid_token" only when a token was actually presented. */
function wwwAuthenticate(authError?: string): string {
  return authError
    ? `Bearer realm="graphql-api", error="invalid_token", error_description="${authError.replace(/"/g, "'")}"`
    : 'Bearer realm="graphql-api"';
}

/**
 * HTTP status policy + one structured log line per operation.
 *   UNAUTHENTICATED anywhere in the result  -> 401 + WWW-Authenticate (a protected field was requested without a token;
 *                                              an invalid token never gets this far, see buildContext)
 *   FORBIDDEN and no field succeeded        -> 403
 *   anything else                           -> GraphQL default (200 with partial data + errors)
 */
export function httpStatusPlugin(logger: Logger): ApolloServerPlugin<Context> {
  return {
    async requestDidStart() {
      const started = performance.now();
      return {
        async willSendResponse(rc) {
          const codes: string[] = [];
          let allFailed = false;
          if (rc.response.body.kind === 'single') {
            const { data, errors } = rc.response.body.singleResult;
            for (const e of errors ?? []) codes.push(String(e.extensions?.['code'] ?? 'INTERNAL_SERVER_ERROR'));
            allFailed = !data || Object.values(data).every((v) => v === null);
          }
          const out = rc.response.http;
          if (codes.includes('UNAUTHENTICATED')) {
            out.status = 401;
            out.headers.set('www-authenticate', wwwAuthenticate());
          } else if (codes.includes('FORBIDDEN') && allFailed) {
            out.status = 403;
          }
          const user = rc.contextValue.user;
          logger.info('graphql', {
            operationName: rc.operationName ?? rc.request.operationName ?? null,
            operation: rc.operation?.operation ?? null,
            sub: user?.sub ?? null,
            roles: user?.roles ?? [],
            status: out.status ?? 200,
            errors: codes,
            durationMs: Math.round((performance.now() - started) * 10) / 10,
          });
        },
      };
    },
  };
}

export function createApolloServer({ cfg, orders, logger = silentLogger, httpServer, fetchImpl }: ApolloDeps): ApolloServer<Context> {
  return new ApolloServer<Context>({
    typeDefs,
    resolvers: createResolvers({ cfg, orders, logger, fetchImpl }),
    introspection: true, // demo: keep the Sandbox usable although the container runs with NODE_ENV=production
    includeStacktraceInErrorResponses: false, // never leak stack traces
    plugins: [
      ...(httpServer ? [ApolloServerPluginDrainHttpServer({ httpServer })] : []),
      ApolloServerPluginLandingPageLocalDefault({ embed: true, footer: false }), // GET /graphql -> embedded Apollo Sandbox
      httpStatusPlugin(logger),
    ],
  });
}

/**
 * Builds the per-request context: verifies the bearer token (if any) and exposes the user to the resolvers.
 *   no token         -> anonymous context (public fields work, protected ones answer UNAUTHENTICATED)
 *   invalid token    -> the whole request is refused with 401 + `WWW-Authenticate: ... error="invalid_token"`
 *                       (RFC 6750 §3.1) — the same answer Envoy Gateway's JWT SecurityPolicy gives at the edge,
 *                       so clients see one behaviour with or without the edge policy
 *   IdP unreachable  -> 503, never "anonymous" (fail closed)
 * Apollo merges `extensions.http` of an error thrown here into the response and strips it from the body.
 */
export function buildContext(verifier: Verifier, logger: Logger = silentLogger) {
  return async ({ req }: { req: Request }): Promise<Context> => {
    let result: Awaited<ReturnType<Verifier['authenticate']>>;
    try {
      result = await verifier.authenticate(req.headers.authorization);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      // We cannot tell whether the token is good -> fail closed with 503, never "anonymous".
      logger.error('identity provider unavailable', { error: e.message });
      throw new GraphQLError('cannot validate token: identity provider unavailable', {
        extensions: { code: 'IDP_UNAVAILABLE', http: { status: 503 } },
      });
    }
    if (result.error) {
      // The operation (and with it the request-log plugin) never runs when the context throws -> log here.
      logger.info('graphql', { sub: null, roles: [], status: 401, errors: ['UNAUTHENTICATED'], reason: result.error });
      throw new GraphQLError(`invalid token: ${result.error}`, {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401, headers: new Map([['www-authenticate', wwwAuthenticate(result.error)]]) } },
      });
    }
    return { user: result.user };
  };
}

/** CORS for browser clients: explicit origin list (`*` wildcards allowed, e.g. http://*.127.0.0.1.nip.io), Authorization header permitted, no cookies. */
export function corsOptions(origins: string[]): CorsOptions {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchers = origins.map((o) => (o.includes('*') ? new RegExp(`^${o.split('*').map(escape).join('[^/]*')}$`) : o));
  return {
    origin: matchers,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Apollo-Require-Preflight', 'X-Apollo-Operation-Name'],
    exposedHeaders: ['WWW-Authenticate'],
    credentials: false, // bearer tokens only — no cookies involved
    maxAge: 600,
  };
}

export interface ExpressDeps {
  cfg: Config;
  apollo: ApolloServer<Context>;
  verifier: Verifier;
  logger?: Logger;
  /** Readiness override (server.ts flips it during shutdown). Defaults to the discovery state. */
  isReady?: () => boolean;
}

export function createExpressApp({ cfg, apollo, verifier, logger = silentLogger, isReady }: ExpressDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // we sit behind Envoy Gateway

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', (_req, res) => {
    const discovery = verifier.state();
    const ready = isReady ? isReady() : discovery.ready;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', discovery });
  });

  app.use(
    '/graphql',
    cors(corsOptions(cfg.corsOrigins)), // must run before auth: preflights carry no Authorization header
    express.json({ limit: '100kb' }), // Express 5 leaves req.body undefined without a parser
    expressMiddleware(apollo, { context: buildContext(verifier, logger) }),
  );

  // Express 5 routes rejected promises and body-parser errors here. Never leak stack traces.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) logger.error('unhandled error', { error: (err as Error).message });
    res.status(status).json({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      error_description: status >= 500 ? 'internal server error' : (err as Error).message,
    });
  });
  return app;
}
