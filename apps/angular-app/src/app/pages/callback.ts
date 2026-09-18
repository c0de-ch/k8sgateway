import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

/**
 * redirect_uri of the OIDC client. By the time this component renders, the app initializer has
 * already exchanged ?code=&state= for tokens (AuthService.init) - here we only report errors and
 * continue to the page the user originally asked for.
 */
@Component({
  selector: 'app-callback',
  imports: [RouterLink],
  template: `
    <div class="card">
      @if (failed()) {
        <h2>Sign-in failed</h2>
        <div class="banner error"><code>{{ auth.error() }}</code></div>
        <p><a routerLink="/" class="btn">Back to home</a></p>
      } @else {
        <p><span class="spinner"></span> Signing you in&hellip;</p>
      }
    </div>
  `,
})
export class Callback implements OnInit {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly failed = signal(false);

  ngOnInit(): void {
    if (!this.auth.isAuthenticated()) {
      this.failed.set(true);
      if (!this.auth.error()) this.auth.error.set('No tokens were received on /callback.');
      return;
    }
    const target = this.auth.takeReturnUrl() ?? '/';
    setTimeout(() => void this.router.navigateByUrl(target, { replaceUrl: true }));
  }
}
