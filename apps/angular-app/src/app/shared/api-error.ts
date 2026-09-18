import { Component, computed, inject, input } from '@angular/core';
import { ApiError } from '../core/api.service';
import { AuthService } from '../core/auth.service';

/** Renders API failures as friendly banners: 401 (token rejected), 403 (role missing), network errors. */
@Component({
  selector: 'app-api-error',
  template: `
    @if (error(); as e) {
      <div class="banner" [class.warn]="e.status === 403" [class.error]="e.status !== 403">
        <strong>{{ title() }}</strong>
        <p>{{ hint() }}</p>
        <code>HTTP {{ e.status }} - {{ e.message }}</code>
      </div>
    }
  `,
})
export class ApiErrorBanner {
  private readonly auth = inject(AuthService);
  readonly error = input<ApiError | null>(null);

  readonly title = computed(() => {
    switch (this.error()?.status) {
      case 401: return 'Not authenticated (401)';
      case 403: return 'Forbidden (403)';
      case 0: return 'API unreachable';
      default: return 'Request failed';
    }
  });

  readonly hint = computed(() => {
    const e = this.error();
    const roles = this.auth.roles();
    switch (e?.status) {
      case 401:
        return 'The API rejected the token: missing, expired or signed by / issued for someone else (iss, aud). ' +
          'Refresh the token on the Profile page or sign in again.';
      case 403:
        return `This endpoint requires the role "${e.requiredRole ?? '?'}". Your access token carries ` +
          `${roles.length ? roles.map((r) => `"${r}"`).join(', ') : 'no roles'}. ` +
          'The API enforces this regardless of what the UI shows.';
      case 0:
        return 'Network or CORS error: is the API running and is this origin listed in its CORS_ORIGINS?';
      default:
        return 'The API returned an unexpected response.';
    }
  });
}
