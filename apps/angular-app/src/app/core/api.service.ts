import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ConfigService } from './config.service';

/** Error shape the pages render: HTTP status plus the API's message. */
export interface ApiError {
  status: number;
  message: string;
  requiredRole?: string;
}
export interface Me {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  roles: string[];
  claims: Record<string, unknown>;
}
export interface Order {
  id: string;
  item: string;
  quantity: number;
  owner: string;
  createdAt: string;
}
export interface Stats {
  orders: number;
  users: number;
  uptimeSeconds: number;
}

/**
 * REST API client. Uses HttpClient; the Authorization: Bearer header is added by the
 * angular-oauth2-oidc interceptor for every URL under apiUrl (see app.config.ts).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private url(path: string): string {
    return this.config.get().apiUrl.replace(/\/$/, '') + path;
  }

  getPublic() { return this.call(this.http.get<unknown>(this.url('/api/public'))); }
  getMe() { return this.call(this.http.get<Me>(this.url('/api/me'))); }
  getOrders() { return this.call(this.http.get<Order[]>(this.url('/api/orders'))); }
  createOrder(item: string, quantity: number) {
    return this.call(this.http.post<Order>(this.url('/api/orders'), { item, quantity }));
  }
  getAdminStats() { return this.call(this.http.get<Stats>(this.url('/api/admin/stats'))); }
  getAdminOrders() { return this.call(this.http.get<Order[]>(this.url('/api/admin/orders'))); }

  private call<T>(req: Observable<T>): Promise<T> {
    return firstValueFrom(req).catch((e: unknown) => {
      throw toApiError(e);
    });
  }
}

/** Maps HttpClient errors to {status, message}; understands the APIs' JSON error bodies. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof HttpErrorResponse) {
    const body = (e.error && typeof e.error === 'object' ? e.error : {}) as Record<string, unknown>;
    const fallback = e.status === 0 ? 'network or CORS error - is the API reachable from this origin?' : e.statusText;
    return {
      status: e.status,
      message: String(body['error_description'] ?? body['error'] ?? fallback),
      requiredRole: typeof body['required_role'] === 'string' ? body['required_role'] : undefined,
    };
  }
  return { status: -1, message: e instanceof Error ? e.message : String(e) };
}

export function isApiError(e: unknown): e is ApiError {
  return !!e && typeof e === 'object' && 'status' in e && 'message' in e;
}
