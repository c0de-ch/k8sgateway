/**
 * Server-only configuration, read from process.env at REQUEST time (never at build time),
 * so a single container image works with any IdP: change the env, restart the pod.
 * Variable names follow the shared OIDC contract used by every app in this repository.
 */
import { log } from "./log";

export type ClientAuthMethod = "client_secret_post" | "client_secret_basic" | "none";
const CLIENT_AUTH_METHODS: ClientAuthMethod[] = ["client_secret_post", "client_secret_basic", "none"];

export interface AppConfig {
  /** Public origin of this app, e.g. http://next.127.0.0.1.nip.io — base for redirect_uri and all redirects. */
  publicUrl: string;
  /** Base URL used for discovery: ${issuer}/.well-known/openid-configuration */
  oidcIssuer: string;
  /** Expected `issuer` in the discovery document / `iss` claim when it differs from oidcIssuer (Oracle). */
  oidcIssuerClaim: string;
  /** Optional override of the JWKS URL used to verify ID-token signatures (e.g. a cluster-internal URL). */
  oidcJwksUri: string | undefined;
  oidcClientId: string;
  oidcClientSecret: string | undefined;
  oidcClientAuth: ClientAuthMethod;
  oidcScope: string;
  /** When true, refuse to talk to a plain-http IdP even if OIDC_ISSUER is http:// */
  oidcRequireHttps: boolean;
  /** Dotted path to the roles array inside the ACCESS token, e.g. "roles" or "realm_access.roles" */
  rolesClaim: string;
  roleUser: string;
  roleAdmin: string;
  restApiInternalUrl: string;
  graphqlInternalUrl: string;
  /** 64 hex chars = 32 bytes, the AES-256-GCM key for the session cookie */
  sessionSecret: string;
  idpName: string;
  logLevel: "info" | "debug";
}

const env = (name: string, fallback: string): string => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

const isClientAuth = (value: string): value is ClientAuthMethod => (CLIENT_AUTH_METHODS as string[]).includes(value);

let warnedClientAuth = false;
/** A typo must not turn every page into a 500: log once, fall back to the default; /readyz reports the problem. */
function parseClientAuth(value: string): ClientAuthMethod {
  if (isClientAuth(value)) return value;
  if (!warnedClientAuth) {
    warnedClientAuth = true;
    log.error("invalid OIDC_CLIENT_AUTH, using client_secret_post", { value, allowed: CLIENT_AUTH_METHODS });
  }
  return "client_secret_post";
}

/** Strict validation for /readyz: everything getConfig() tolerates with a fallback is an error here. */
export function configProblems(): string[] {
  const problems: string[] = [];
  const auth = env("OIDC_CLIENT_AUTH", "client_secret_post");
  if (!isClientAuth(auth)) problems.push(`OIDC_CLIENT_AUTH must be one of ${CLIENT_AUTH_METHODS.join(" | ")} (got "${auth}")`);
  for (const name of ["PUBLIC_URL", "OIDC_ISSUER"]) {
    const value = process.env[name];
    if (value && !URL.canParse(value)) problems.push(`${name} is not a valid URL: "${value}"`);
  }
  return problems;
}

/** Parses the environment on every call; it is cheap and keeps configuration dynamic. */
export function getConfig(): AppConfig {
  const oidcIssuer = env("OIDC_ISSUER", "http://idp.127.0.0.1.nip.io").replace(/\/+$/, "");
  const oidcClientAuth = parseClientAuth(env("OIDC_CLIENT_AUTH", "client_secret_post"));
  return {
    publicUrl: env("PUBLIC_URL", "http://next.127.0.0.1.nip.io").replace(/\/+$/, ""),
    oidcIssuer,
    // Oracle IAM Identity Domains publishes issuer "https://identity.oraclecloud.com/" (with slash) — keep as given.
    oidcIssuerClaim: env("OIDC_ISSUER_CLAIM", oidcIssuer),
    oidcJwksUri: env("OIDC_JWKS_URI", "") || undefined,
    oidcClientId: env("OIDC_CLIENT_ID", "nextjs-app"),
    // Demo value; real deployments inject the secret from a Kubernetes Secret.
    oidcClientSecret: oidcClientAuth === "none" ? undefined : env("OIDC_CLIENT_SECRET", "nextjs-secret"),
    oidcClientAuth,
    // Keycloak: do NOT request offline_access (it turns refresh tokens into never-expiring offline tokens); use "openid profile email".
    oidcScope: env("OIDC_SCOPE", "openid profile email offline_access"),
    oidcRequireHttps: env("OIDC_REQUIRE_HTTPS", "false") === "true",
    rolesClaim: env("ROLES_CLAIM", "roles"),
    roleUser: env("ROLE_USER", "user"),
    roleAdmin: env("ROLE_ADMIN", "admin"),
    restApiInternalUrl: env("REST_API_INTERNAL_URL", "http://rest-api.k8sgateway.svc.cluster.local:8080").replace(/\/+$/, ""),
    graphqlInternalUrl: env("GRAPHQL_INTERNAL_URL", "http://graphql-api.k8sgateway.svc.cluster.local:4000/graphql"),
    sessionSecret: env("SESSION_SECRET", ""),
    idpName: env("OIDC_IDP_NAME", "Mock IdP"),
    logLevel: env("LOG_LEVEL", "info") === "debug" ? "debug" : "info",
  };
}

/** Cookies must be Secure exactly when the public URL is https (http://*.nip.io is not a secure context). */
export const isHttpsPublicUrl = (cfg: AppConfig): boolean => cfg.publicUrl.startsWith("https://");
