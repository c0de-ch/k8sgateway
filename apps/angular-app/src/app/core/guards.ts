import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AppRole, AuthService } from './auth.service';

/** Sends anonymous users to the IdP; the requested URL comes back through the OAuth state parameter. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (auth.isAuthenticated()) return true;
  void auth.login(state.url);
  return false;
};

/**
 * Hides a route from users without the given application role.
 * This is a UI convenience only - every API request is authorized again on the server.
 */
export function roleGuard(role: AppRole): CanActivateFn {
  return (_route, state) => {
    if (inject(AuthService).hasRole(role)) return true;
    return inject(Router).createUrlTree(['/'], { queryParams: { denied: role, from: state.url } });
  };
}
