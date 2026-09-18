import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { AuthService } from '../core/auth.service';
import { ConfigService } from '../core/config.service';
import { copyText } from '../core/clipboard';

/** Shows the ID token claims, the decoded access token, its expiry and offers refresh/copy actions. */
@Component({
  selector: 'app-profile',
  imports: [JsonPipe],
  template: `
    <h1>Profile</h1>
    <p class="muted">Everything below is decoded in the browser without verifying signatures - the APIs do that.</p>

    <div class="grid">
      <div class="card">
        <h2>ID token claims</h2>
        <p class="muted">Who you are, validated by the library (issuer, audience = client id, nonce, expiry).</p>
        <div class="table-wrap">
          <table class="kv">
            @for (row of idClaims(); track row.key) {
              <tr><td>{{ row.key }}</td><td>{{ row.value }}</td></tr>
            }
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Access token</h2>
        <p>
          Expires in <span class="countdown" [class.soon]="secondsLeft() < 60" [class.expired]="secondsLeft() <= 0">{{ countdown() }}</span>&ngsp;
          <span class="muted">(automatic refresh at 75% of the lifetime via the refresh token)</span>
        </p>
        <p>
          Roles at <code>{{ cfg.rolesClaim }}</code>:
          @for (r of auth.roles(); track r) {
            <span class="badge" [class.admin]="r === cfg.roleAdmin" [class.user]="r === cfg.roleUser">{{ r }}</span>
          } @empty { <span class="muted">none</span> }
        </p>
        <div class="actions">
          <button class="btn primary" (click)="refresh()" [disabled]="busy()">Refresh token</button>
          <button class="btn" (click)="copy(auth.accessToken() ?? '', 'token')">Copy token</button>
          <button class="btn" (click)="copy(curl(), 'curl')">Copy curl</button>
          @if (notice(); as n) { <span class="badge ok">{{ n }}</span> }
        </div>
        <h3>Header</h3>
        <pre>{{ decoded()?.header | json }}</pre>
        <h3>Payload</h3>
        <pre>{{ decoded()?.payload | json }}</pre>
      </div>
    </div>

    <div class="card">
      <h2>Raw access token</h2>
      <p class="muted">Send it as <code>Authorization: Bearer &lt;token&gt;</code>. Paste it into the IdP's token debugger
        or use the curl command:</p>
      <pre class="token">{{ auth.accessToken() }}</pre>
      <pre>{{ curl() }}</pre>
    </div>
  `,
})
export class Profile {
  readonly auth = inject(AuthService);
  readonly cfg = inject(ConfigService).get();
  readonly decoded = this.auth.decodedAccessToken;
  readonly busy = signal(false);
  readonly notice = signal<string | null>(null);

  private readonly now = signal(Date.now());

  readonly idClaims = computed(() =>
    Object.entries(this.auth.claims() ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
  );

  /** seconds until the access token's exp claim */
  readonly secondsLeft = computed(() => {
    const exp = this.decoded()?.payload['exp'];
    return typeof exp === 'number' ? Math.floor(exp - this.now() / 1000) : 0;
  });
  readonly countdown = computed(() => {
    const s = Math.max(0, this.secondsLeft());
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  readonly curl = computed(
    () => `curl -H "Authorization: Bearer ${this.auth.accessToken() ?? '<token>'}" ${this.cfg.apiUrl}/api/me`,
  );

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async refresh(): Promise<void> {
    this.busy.set(true);
    await this.auth.refresh();
    this.busy.set(false);
    this.flash(this.auth.error() ? 'refresh failed' : 'token refreshed');
  }

  async copy(text: string, what: string): Promise<void> {
    this.flash((await copyText(text)) ? `${what} copied` : 'copy failed');
  }

  private flash(msg: string): void {
    this.notice.set(msg);
    setTimeout(() => this.notice.set(null), 2500);
  }
}
