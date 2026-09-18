import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { ConfigService } from './config.service';

export interface GraphqlResult {
  status: number;
  data?: unknown;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

/** The operations of the tutorial's GraphQL API (apps/graphql-api). */
export const GQL = {
  hello: `query { hello }`,
  me: `query { me { sub name preferredUsername email roles } }`,
  orders: `query { orders { id item quantity owner createdAt } }`,
  restOrders: `query { restOrders { id item quantity owner createdAt } }`,
  adminStats: `query { adminStats { orders users uptimeSeconds } }`,
  createOrder: `mutation CreateOrder($item: String!, $quantity: Int!) {
  createOrder(item: $item, quantity: $quantity) { id item quantity owner createdAt }
}`,
} as const;

/**
 * GraphQL client using plain fetch: the Authorization header is set by hand here, which is the
 * alternative to the HttpClient interceptor used by ApiService.
 */
@Injectable({ providedIn: 'root' })
export class GraphqlService {
  private readonly auth = inject(AuthService);
  private readonly config = inject(ConfigService);

  async run(query: string, variables: Record<string, unknown> = {}): Promise<GraphqlResult> {
    // Content-Type: application/json is mandatory: Apollo's CSRF prevention rejects "simple" requests.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.auth.accessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(this.config.get().graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json().catch(() => ({}))) as Omit<GraphqlResult, 'status'>;
      return { status: res.status, ...body };
    } catch (e) {
      return { status: 0, errors: [{ message: `network or CORS error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
}
