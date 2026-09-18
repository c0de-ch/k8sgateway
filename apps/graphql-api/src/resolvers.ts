/**
 * Resolvers + authorization gates.
 *
 * Every protected resolver starts with requireUser()/requireRole(). Errors carry
 * `extensions.code` UNAUTHENTICATED / FORBIDDEN; the HTTP status is derived from those codes
 * by the plugin in app.ts (401 when a protected field was requested without a token, 403 when the whole
 * operation was forbidden). A token that was sent but is invalid never reaches a resolver: buildContext()
 * in app.ts already answers 401 for the whole request.
 */
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import type { AuthUser } from './auth.js';
import type { Config } from './config.js';
import { silentLogger, type Logger } from './log.js';
import type { Order, OrderStore } from './orders.js';

export interface Context {
  /** null when no token was sent (an invalid token is rejected before the context exists). */
  user: AuthUser | null;
}

export interface ResolverDeps {
  cfg: Pick<Config, 'roleUser' | 'roleAdmin' | 'restApiInternalUrl'>;
  orders: OrderStore;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export function requireUser(ctx: Context): AuthUser {
  if (!ctx.user) throw new GraphQLError('authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  return ctx.user;
}

/** `role` is the configured claim value (ROLE_USER / ROLE_ADMIN), compared against the raw roles list. */
export function requireRole(ctx: Context, role: string): AuthUser {
  const user = requireUser(ctx);
  if (!user.roles.includes(role)) {
    throw new GraphQLError(`role "${role}" required`, { extensions: { code: 'FORBIDDEN', requiredRole: role } });
  }
  return user;
}

/** Output-only JSON scalar (exposes the raw claims); literal parsing is included for completeness. */
function parseJsonLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseJsonLiteral);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseJsonLiteral(f.value)]));
    default:
      return null;
  }
}

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: parseJsonLiteral,
});

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The REST API's Order shape matches ours; coerce defensively so a numeric id or snake_case date cannot break the non-null schema. */
function toOrder(raw: unknown): Order {
  const o = asRecord(raw);
  return {
    id: String(o['id'] ?? ''),
    item: String(o['item'] ?? ''),
    quantity: Number(o['quantity'] ?? 0),
    owner: String(o['owner'] ?? ''),
    createdAt: String(o['createdAt'] ?? o['created_at'] ?? ''),
  };
}

export function createResolvers(deps: ResolverDeps) {
  const { cfg, orders } = deps;
  const logger = deps.logger ?? silentLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const startedAt = Date.now();

  /**
   * Token relay: call the REST API with the SAME bearer token the client sent us.
   * The REST API validates it independently (issuer, audience, signature) — nothing is re-issued or trusted transitively.
   */
  async function relayOrders(user: AuthUser): Promise<Order[]> {
    const url = `${cfg.restApiInternalUrl}/api/orders`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${user.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      logger.warn('rest relay failed', { url, error: (e as Error).message });
      throw new GraphQLError(`REST API unreachable (${url})`, { extensions: { code: 'UPSTREAM_UNAVAILABLE' } });
    }
    if (!res.ok) {
      // The upstream body goes to the log for operators — never into the response (no echoing of foreign error pages).
      logger.warn('rest relay rejected', { url, status: res.status, body: (await res.text()).slice(0, 300) });
      throw new GraphQLError(`REST API answered HTTP ${res.status}`, { extensions: { code: 'UPSTREAM_ERROR', upstreamStatus: res.status } });
    }
    const body: unknown = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(asRecord(body)['orders']) ? (asRecord(body)['orders'] as unknown[]) : undefined;
    if (!list) throw new GraphQLError('REST API returned an unexpected payload', { extensions: { code: 'UPSTREAM_ERROR' } });
    return list.map(toOrder);
  }

  return {
    JSON: JSONScalar,
    Query: {
      hello: (_p: unknown, _a: unknown, ctx: Context): string =>
        ctx.user ? `Hello ${ctx.user.name ?? ctx.user.preferredUsername ?? ctx.user.sub}!` : 'Hello, anonymous! Send a bearer token to see more.',

      me: (_p: unknown, _a: unknown, ctx: Context) => {
        const u = requireUser(ctx);
        return { sub: u.sub, name: u.name ?? null, preferredUsername: u.preferredUsername ?? null, email: u.email ?? null, roles: u.roles, claims: u.claims };
      },

      orders: (_p: unknown, _a: unknown, ctx: Context): Order[] => {
        requireRole(ctx, cfg.roleUser);
        return orders.list();
      },

      restOrders: (_p: unknown, _a: unknown, ctx: Context): Promise<Order[]> => relayOrders(requireRole(ctx, cfg.roleUser)),

      adminStats: (_p: unknown, _a: unknown, ctx: Context) => {
        requireRole(ctx, cfg.roleAdmin);
        return { orders: orders.count(), users: orders.ownerCount(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) };
      },
    },
    Mutation: {
      createOrder: (_p: unknown, args: { item: string; quantity: number }, ctx: Context): Order => {
        const user = requireRole(ctx, cfg.roleUser);
        const item = args.item.trim();
        if (item === '') throw new GraphQLError('item must not be empty', { extensions: { code: 'BAD_USER_INPUT', argumentName: 'item' } });
        if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 1000) {
          throw new GraphQLError('quantity must be between 1 and 1000', { extensions: { code: 'BAD_USER_INPUT', argumentName: 'quantity' } });
        }
        return orders.create({ item, quantity: args.quantity, owner: user.preferredUsername ?? user.sub });
      },
    },
  };
}
