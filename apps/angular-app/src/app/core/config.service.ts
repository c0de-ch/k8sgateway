import { Injectable, signal } from '@angular/core';

/**
 * Runtime configuration, loaded from /config.json before the application starts.
 * The keys mirror the OIDC contract of the repository (OIDC_ISSUER -> issuer, ...), so switching
 * the IdP means swapping this one file (a ConfigMap in Kubernetes) - no rebuild.
 */
export interface AppConfig {
  /** Display name of the IdP shown in the navigation bar. */
  idpName: string;
  /** OIDC_ISSUER: discovery document at <issuer>/.well-known/openid-configuration. */
  issuer: string;
  /** OIDC_CLIENT_ID of this public client (a SPA cannot keep a secret). */
  clientId: string;
  /** OIDC_SCOPE: "openid profile email"; add offline_access only where the IdP needs it for a refresh token (Entra, Oracle - never Keycloak). */
  scope: string;
  /** OIDC_REQUIRE_HTTPS: false only for plain-http development IdPs (mock IdP, Keycloak in kind). */
  requireHttps: boolean;
  /** Every discovery endpoint must start with the issuer URL. False for Entra ID (endpoints live elsewhere). */
  strictDiscoveryDocumentValidation: boolean;
  /** Accept a discovery 'issuer' that differs from the issuer URL (Oracle IAM). Keep false otherwise. */
  skipIssuerCheck?: boolean;
  /** Verbose angular-oauth2-oidc logging - prints complete token responses (access, ID and refresh tokens) to the console. Never in production. */
  showDebugInformation?: boolean;
  /** API_URL: base URL of the REST API (receives the access token). */
  apiUrl: string;
  /** GRAPHQL_URL: GraphQL endpoint (receives the access token). */
  graphqlUrl: string;
  /** ROLES_CLAIM: dotted path of the roles array inside the ACCESS token, e.g. "roles" or "realm_access.roles". */
  rolesClaim: string;
  /** ROLE_USER / ROLE_ADMIN: claim values that grant the application roles. */
  roleUser: string;
  roleAdmin: string;
}

const REQUIRED: (keyof AppConfig)[] = ['issuer', 'clientId', 'scope', 'apiUrl', 'graphqlUrl', 'rolesClaim'];

@Injectable({ providedIn: 'root' })
export class ConfigService {
  /** null until load() succeeded */
  readonly value = signal<AppConfig | null>(null);

  /** The loaded configuration. Using it before load() is a programming error. */
  get(): AppConfig {
    const cfg = this.value();
    if (!cfg) throw new Error('config.json is not loaded yet');
    return cfg;
  }

  async load(): Promise<AppConfig> {
    // Relative URL honours <base href>; no-store makes an IdP switch visible on the next reload.
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
    return this.set((await res.json()) as Partial<AppConfig>);
  }

  /** Validates and applies defaults. Exposed for tests. */
  set(raw: Partial<AppConfig>): AppConfig {
    const missing = REQUIRED.filter((k) => !raw[k]);
    if (missing.length) throw new Error(`config.json is missing: ${missing.join(', ')}`);
    const cfg: AppConfig = {
      ...(raw as AppConfig),
      idpName: raw.idpName ?? 'IdP',
      requireHttps: raw.requireHttps ?? true,
      strictDiscoveryDocumentValidation: raw.strictDiscoveryDocumentValidation ?? true,
      roleUser: raw.roleUser ?? 'user',
      roleAdmin: raw.roleAdmin ?? 'admin',
    };
    this.value.set(cfg);
    return cfg;
  }

  /**
   * True for URLs that may receive the access token (REST + GraphQL). Used by the HTTP interceptor.
   * Compares origin and path segments, not a bare string prefix: with apiUrl http://api.example.com
   * neither http://api.example.com.evil.test/ nor http://api.example.community/ may get the token.
   */
  isApiUrl(url: string): boolean {
    const cfg = this.value();
    return !!cfg && [cfg.apiUrl, cfg.graphqlUrl].some((base) => isUnder(url, base));
  }
}

/** url has exactly the origin of base and base's path or a sub-path of it. */
function isUnder(url: string, base: string): boolean {
  try {
    const u = new URL(url, location.origin); // relative URLs resolve against the app's own origin
    const b = new URL(base, location.origin);
    const path = b.pathname.replace(/\/$/, '');
    return u.origin === b.origin && (u.pathname === path || u.pathname.startsWith(path + '/'));
  } catch {
    return false; // unparsable URL: never attach a token
  }
}
