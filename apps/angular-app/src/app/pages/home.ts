import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService, isApiError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ConfigService } from '../core/config.service';
import { ApiErrorBanner } from '../shared/api-error';

const DOCS = 'https://github.com/c0de-ch/k8sgateway/blob/main/docs/08-angular.md';

@Component({
  selector: 'app-home',
  imports: [RouterLink, ApiErrorBanner],
  template: `
    @if (config(); as cfg) {
      @if (denied(); as role) {
        <div class="banner warn">
          <strong>Role "{{ role }}" required</strong>
          <p>
            The UI hid <code>{{ from() }}</code> because your access token does not contain
            <code>{{ role === 'admin' ? cfg.roleAdmin : cfg.roleUser }}</code> at <code>{{ cfg.rolesClaim }}</code>.
            Sign in as <strong>alice</strong> to see the admin area. The UI check is only a convenience -
            the API enforces roles on every request. Try it:
          </p>
          <div class="actions">
            <button class="btn sm" (click)="tryAdmin()">Call GET /api/admin/stats anyway</button>
            @if (tried()) { <span class="badge ok">HTTP 200 - unexpected, check the API's role mapping</span> }
          </div>
          <app-api-error [error]="apiError()" />
        </div>
      }

      <div class="grid">
        <div class="card">
          <h2>Who you are</h2>
          @if (auth.isAuthenticated()) {
            <p><strong>{{ auth.displayName() }}</strong>&ngsp;<span class="muted">({{ auth.claims()?.['email'] }})</span></p>
            <p class="muted mono">sub: {{ auth.claims()?.['sub'] }}</p>
            <p>
              Roles from the access token:
              @for (r of auth.roles(); track r) {
                <span class="badge" [class.admin]="r === cfg.roleAdmin" [class.user]="r === cfg.roleUser">{{ r }}</span>
              } @empty { <span class="muted">none</span> }
            </p>
            <div class="actions">
              <a routerLink="/profile" class="btn primary">Inspect tokens</a>
              <button class="btn" (click)="auth.logout()">Logout</button>
            </div>
          } @else {
            <p class="muted">You are not signed in. The IdP <strong>{{ cfg.idpName }}</strong> authenticates you;
              this app only receives tokens.</p>
            <div class="actions">
              <button class="btn primary" (click)="auth.login('/profile')">Login with {{ cfg.idpName }}</button>
            </div>
            <p class="muted">Demo users: <code>alice</code> (admin, user), <code>bob</code> (user), <code>carol</code> (no roles);
              the password equals the username.</p>
          }
        </div>

        <div class="card">
          <h2>Links</h2>
          <table class="kv">
            <tr><td>IdP</td><td><a [href]="cfg.issuer" target="_blank" rel="noopener">{{ cfg.issuer }}</a></td></tr>
            <tr><td>Discovery</td><td><a [href]="discovery()" target="_blank" rel="noopener">.well-known/openid-configuration</a></td></tr>
            <tr><td>REST API</td><td><a [href]="cfg.apiUrl + '/api/public'" target="_blank" rel="noopener">{{ cfg.apiUrl }}/api/public</a></td></tr>
            <tr><td>GraphQL</td><td><a [href]="cfg.graphqlUrl" target="_blank" rel="noopener">{{ cfg.graphqlUrl }}</a></td></tr>
            <tr><td>Tutorial</td><td><a [href]="docs" target="_blank" rel="noopener">docs/08-angular.md</a></td></tr>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>How this app obtains tokens (Authorization Code flow + PKCE)</h2>
        <ol class="steps">
          <li><strong>Login</strong> redirects the browser to the IdP's authorization endpoint with <code>client_id</code>,
            <code>redirect_uri=/callback</code>, the scopes, a random <code>state</code>, a <code>nonce</code> and a PKCE
            <code>code_challenge</code> (SHA-256 of a secret <code>code_verifier</code> that stays in this browser).</li>
          <li>You authenticate <em>at the IdP</em> - this app never sees your password. The IdP redirects back to
            <code>/callback?code=…&amp;state=…</code>.</li>
          <li>The app checks that <code>state</code> matches (CSRF protection) and POSTs <code>code</code> +
            <code>code_verifier</code> to the token endpoint. There is no client secret: PKCE proves that the same browser
            started the flow.</li>
          <li>The IdP returns an <strong>ID token</strong> (who you are - nonce and issuer are validated), an
            <strong>access token</strong> (sent as <code>Authorization: Bearer</code> to the REST and GraphQL APIs) and a
            <strong>refresh token</strong> that renews the access token silently (Keycloak and the mock IdP issue one for
            the code flow; Entra ID and Oracle need the <code>offline_access</code> scope).</li>
          <li>The APIs validate every access token themselves (signature via JWKS, <code>iss</code>, <code>aud</code>,
            <code>exp</code>) and enforce roles. The app only reads the roles claim to hide menu entries.</li>
        </ol>
        <p class="muted">Read the full walkthrough in <a [href]="docs" target="_blank" rel="noopener">docs/08-angular.md</a>.</p>
      </div>
    } @else {
      <!-- config.json failed to load: the shell shows the error banner, this explains where the file comes from -->
      <div class="card">
        <h2>Configuration missing</h2>
        <p><code>/config.json</code> could not be loaded or is incomplete, so the app does not know its IdP yet
          (the exact problem is in the banner above). Locally, edit <code>public/config.json</code>; in Kubernetes the
          file is mounted from the ConfigMap of the active overlay (<code>deploy/overlays/&lt;idp&gt;</code>) - restart
          the Deployment after changing it.</p>
        <p class="muted">Read the full walkthrough in <a [href]="docs" target="_blank" rel="noopener">docs/08-angular.md</a>.</p>
      </div>
    }
  `,
})
export class Home {
  readonly auth = inject(AuthService);
  /** null while/if config.json is not loaded - the template then explains instead of crashing */
  readonly config = inject(ConfigService).value;
  private readonly api = inject(ApiService);
  readonly docs = DOCS;
  readonly discovery = computed(
    () => (this.config()?.issuer ?? '').replace(/\/$/, '') + '/.well-known/openid-configuration',
  );

  /** query parameters set by roleGuard (bound via withComponentInputBinding) */
  readonly denied = input<string>();
  readonly from = input<string>();

  readonly apiError = signal<ApiError | null>(null);
  readonly tried = signal(false);

  async tryAdmin(): Promise<void> {
    this.apiError.set(null);
    this.tried.set(false);
    try {
      await this.api.getAdminStats();
      this.tried.set(true);
    } catch (e) {
      this.apiError.set(isApiError(e) ? e : { status: -1, message: String(e) });
    }
  }
}
