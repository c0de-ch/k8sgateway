import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './core/guards';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home').then((m) => m.Home), title: 'Home' },
  { path: 'callback', loadComponent: () => import('./pages/callback').then((m) => m.Callback), title: 'Signing in' },
  { path: 'profile', canActivate: [authGuard], loadComponent: () => import('./pages/profile').then((m) => m.Profile), title: 'Profile' },
  { path: 'orders', canActivate: [authGuard], loadComponent: () => import('./pages/orders').then((m) => m.Orders), title: 'Orders' },
  { path: 'graphql', canActivate: [authGuard], loadComponent: () => import('./pages/graphql').then((m) => m.Graphql), title: 'GraphQL' },
  // guards run in order: unauthenticated users go to the IdP first, then the role is checked
  { path: 'admin', canActivate: [authGuard, roleGuard('admin')], loadComponent: () => import('./pages/admin').then((m) => m.Admin), title: 'Admin' },
  { path: '**', redirectTo: '' },
];
