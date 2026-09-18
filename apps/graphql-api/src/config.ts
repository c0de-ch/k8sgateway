/**
 * Configuration — environment variables only (12-factor).
 * The variable names are the shared OIDC contract used by every app in this repository.
 */
export interface Config {
  port: number;
  /** Base URL used for discovery: `${issuer}/.well-known/openid-configuration`. */
  issuer: string;
  /** Exact value the `iss` claim must have (Oracle IAM differs from the discovery URL). */
  issuerClaim: string;
  /**
   * True when OIDC_ISSUER_CLAIM was set explicitly. Without it the verifier may adopt the issuer advertised
   * by discovery when it differs from OIDC_ISSUER only by a trailing slash (a common copy/paste slip).
   */
  issuerClaimExplicit: boolean;
  /** Optional JWKS URL override — skips discovery entirely when set. */
  jwksUri?: string;
  /** Value that must be present in the `aud` claim of access tokens. */
  audience: string;
  /** Dotted path to the roles array/string in the access token, e.g. `realm_access.roles`. */
  rolesClaim: string;
  roleUser: string;
  roleAdmin: string;
  corsOrigins: string[];
  /** In-cluster REST API base URL used by the `restOrders` token-relay resolver. */
  restApiInternalUrl: string;
  logLevel: 'info' | 'debug';
  /** Initial back-off between discovery retries (doubles up to 30s). */
  discoveryRetryMs: number;
  /** Pause between "not ready" and draining connections on SIGTERM (lets the endpoint controller catch up). */
  shutdownDelayMs: number;
}

const str = (v: string | undefined, fallback: string): string => (v && v.trim() !== '' ? v.trim() : fallback);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = str(env['OIDC_ISSUER'], 'http://idp.127.0.0.1.nip.io');
  const issuerClaim = env['OIDC_ISSUER_CLAIM']?.trim() || undefined;
  return {
    port: Number(str(env['PORT'], '4000')),
    issuer,
    // Verbatim on purpose: `iss` is compared byte-for-byte (trailing slash included).
    issuerClaim: issuerClaim ?? issuer,
    issuerClaimExplicit: issuerClaim !== undefined,
    jwksUri: env['OIDC_JWKS_URI']?.trim() || undefined,
    audience: str(env['OIDC_AUDIENCE'], 'k8sgateway-api'),
    rolesClaim: str(env['ROLES_CLAIM'], 'roles'),
    roleUser: str(env['ROLE_USER'], 'user'),
    roleAdmin: str(env['ROLE_ADMIN'], 'admin'),
    corsOrigins: str(env['CORS_ORIGINS'], 'http://angular.127.0.0.1.nip.io,http://next.127.0.0.1.nip.io')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    restApiInternalUrl: str(env['REST_API_INTERNAL_URL'], 'http://rest-api.k8sgateway.svc.cluster.local:8080').replace(/\/+$/, ''),
    logLevel: env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
    discoveryRetryMs: Number(str(env['DISCOVERY_RETRY_MS'], '1000')),
    shutdownDelayMs: Number(str(env['SHUTDOWN_DELAY_MS'], '2000')),
  };
}
