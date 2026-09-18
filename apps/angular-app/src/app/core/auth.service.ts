import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthConfig, OAuthErrorEvent, OAuthService } from 'angular-oauth2-oidc';
import { AppConfig, ConfigService } from './config.service';
import { Claims, decodeJwt, extractRoles } from './jwt';

export type AppRole = 'user' | 'admin';

/**
 * Thin wrapper around angular-oauth2-oidc that exposes the authentication state as signals.
 * The app is zoneless: promise callbacks and library events do not trigger change detection by
 * themselves, so every state change goes through sync() -> signals.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly oauth = inject(OAuthService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);

  /** true once discovery and the optional login round trip have been processed */
  readonly ready = signal(false);
  /** last startup / login / refresh problem, shown by the shell */
  readonly error = signal<string | null>(null);
  readonly isAuthenticated = signal(false);
  /** ID-token claims: who the user is */
  readonly claims = signal<Claims | null>(null);
  /** raw access token (sent as Bearer to the APIs) */
  readonly accessToken = signal<string | null>(null);
  /** values found at ROLES_CLAIM in the ACCESS token - UI hint only, the APIs enforce roles */
  readonly roles = signal<string[]>([]);

  readonly decodedAccessToken = computed(() => decodeJwt(this.accessToken()));
  readonly displayName = computed(() => {
    const c = this.claims();
    return (c?.['name'] ?? c?.['preferred_username'] ?? c?.['email'] ?? c?.['sub']) as string | undefined;
  });
  readonly isAdmin = computed(() => this.hasRole('admin'));

  /** Called once by the app initializer, after config.json is loaded. */
  async init(cfg: AppConfig): Promise<void> {
    const authConfig: AuthConfig = {
      issuer: cfg.issuer,
      clientId: cfg.clientId,          // public client: there is no secret in the browser
      responseType: 'code',            // Authorization Code flow; the library adds PKCE (S256) automatically
      scope: cfg.scope,                // 'openid profile email' (+ offline_access only where the IdP needs it for a refresh token)
      redirectUri: window.location.origin + '/callback',
      postLogoutRedirectUri: window.location.origin + '/',
      requireHttps: cfg.requireHttps,  // false only for plain-http development IdPs
      strictDiscoveryDocumentValidation: cfg.strictDiscoveryDocumentValidation, // false for Entra ID
      skipIssuerCheck: cfg.skipIssuerCheck ?? false, // true only when discovery 'issuer' != issuer URL (Oracle)
      useSilentRefresh: false,         // code flow => refresh_token grant, no hidden iframe needed
      timeoutFactor: 0.75,             // 'token_expires' fires after 75% of the lifetime -> refresh
      showDebugInformation: cfg.showDebugInformation ?? false,
    };
    this.oauth.configure(authConfig);
    this.oauth.events.subscribe((e) => {
      if (e instanceof OAuthErrorEvent) {
        console.warn('[oauth]', e.type, e.reason ?? e.params);
        if (e.type === 'token_refresh_error') this.error.set('Token refresh failed - please sign in again.');
      }
      this.sync();
    });
    try {
      // 1. GET <issuer>/.well-known/openid-configuration and the JWKS.
      // 2. If the URL carries ?code=&state= (we are on /callback): check the state (CSRF), then POST
      //    code + PKCE code_verifier to the token endpoint and validate the returned ID token (nonce, iss, aud).
      await this.oauth.loadDiscoveryDocumentAndTryLogin();
    } catch (e) {
      this.error.set(describe(e));
    } finally {
      this.oauth.setupAutomaticSilentRefresh(); // arms on token_received, refreshes on token_expires
      this.sync();
      this.ready.set(true);
    }
  }

  /** Starts the code flow. returnUrl travels in the OAuth `state` parameter and is restored on /callback. */
  async login(returnUrl = '/'): Promise<void> {
    try {
      if (!this.oauth.loginUrl) await this.oauth.loadDiscoveryDocument(); // IdP was down at startup
      this.oauth.initCodeFlow(returnUrl); // full-page redirect to the authorization endpoint
    } catch (e) {
      this.error.set(describe(e));
    }
  }

  /** The returnUrl carried through the login round trip (meaningful right after the callback only). */
  takeReturnUrl(): string | null {
    // the library URL-encodes the custom part of `state` and hands it back verbatim
    const s = this.oauth.state ? decodeURIComponent(this.oauth.state) : '';
    this.oauth.state = undefined;
    return s.startsWith('/') && !s.startsWith('//') ? s : null; // same-origin paths only (no open redirect)
  }

  /** Clears the local tokens and redirects to the IdP's end_session_endpoint (RP-initiated logout). */
  logout(): void {
    this.oauth.logOut();
    void this.router.navigateByUrl('/'); // only visible when the IdP publishes no end_session_endpoint
  }

  /** refresh_token grant. Keycloak and the mock issue a refresh token for the code flow; Entra/Oracle only with offline_access. */
  async refresh(): Promise<void> {
    try {
      await this.oauth.refreshToken();
      this.error.set(null);
    } catch (e) {
      this.error.set(describe(e));
    } finally {
      this.sync();
    }
  }

  hasRole(role: AppRole): boolean {
    const cfg = this.config.value();
    if (!cfg) return false;
    return this.roles().includes(role === 'admin' ? cfg.roleAdmin : cfg.roleUser);
  }

  private sync(): void {
    const ok = this.oauth.hasValidAccessToken();
    const token = ok ? this.oauth.getAccessToken() : null;
    this.isAuthenticated.set(ok);
    this.accessToken.set(token);
    this.claims.set(ok ? ((this.oauth.getIdentityClaims() as Claims | null) ?? null) : null);
    const rolesClaim = this.config.value()?.rolesClaim ?? 'roles';
    this.roles.set(token ? extractRoles(decodeJwt(token)?.payload, rolesClaim) : []);
  }
}

/** Turns library errors (OAuthErrorEvent, HttpErrorResponse, Error) into one readable line. */
function describe(e: unknown): string {
  if (e instanceof OAuthErrorEvent) {
    const p = (e.params ?? {}) as Record<string, string>;
    const r = e.reason as { message?: string; error?: Record<string, string> } | null;
    return p['error_description'] ?? p['error'] ?? r?.error?.['error_description'] ?? r?.message ?? e.type;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
