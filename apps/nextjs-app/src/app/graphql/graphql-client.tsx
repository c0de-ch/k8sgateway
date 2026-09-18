"use client";

import { useState } from "react";
import { Banner } from "@/components/banner";
import { JsonPanel } from "@/components/json-panel";

interface Operation {
  name: string;
  hint: string;
  query: string;
  variables?: Record<string, unknown>;
}

const OPERATIONS: Operation[] = [
  { name: "hello", hint: "public", query: "query { hello }" },
  { name: "me", hint: "authenticated", query: "query { me { sub name preferredUsername email roles } }" },
  { name: "orders", hint: "role user", query: "query { orders { id item quantity owner createdAt } }" },
  { name: "restOrders", hint: "role user · GraphQL relays the token to REST", query: "query { restOrders { id item quantity owner } }" },
  { name: "adminStats", hint: "role admin", query: "query { adminStats { orders users uptimeSeconds } }" },
];

const CREATE_ORDER = `mutation CreateOrder($item: String!, $quantity: Int!) {
  createOrder(item: $item, quantity: $quantity) { id item quantity owner createdAt }
}`;

export function GraphqlClient() {
  const [result, setResult] = useState<{ status: number; body: unknown; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [item, setItem] = useState("keyboard");
  const [quantity, setQuantity] = useState(2);

  async function run(label: string, query: string, variables?: Record<string, unknown>) {
    setBusy(label);
    try {
      const res = await fetch("/api/bff/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ query, variables }),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      setResult({ status: res.status, body, label });
    } finally {
      setBusy(null);
    }
  }

  const codes = extractCodes(result?.body);

  return (
    <div className="stack">
      <section className="card">
        <h2>Queries</h2>
        <div className="row">
          {OPERATIONS.map((op) => (
            <button key={op.name} className="btn" disabled={busy !== null} onClick={() => run(op.name, op.query, op.variables)} title={op.query}>
              {busy === op.name ? "…" : op.name} <span className="muted small">({op.hint})</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>
          Mutation <span className="card-title-note">role user</span>
        </h2>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run("createOrder", CREATE_ORDER, { item, quantity });
          }}
        >
          <label>
            Item
            <input value={item} onChange={(e) => setItem(e.target.value)} required maxLength={60} />
          </label>
          <label>
            Quantity
            <input type="number" min={1} max={1000} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required />
          </label>
          <button className="btn btn-primary" disabled={busy !== null}>
            createOrder
          </button>
        </form>
      </section>

      <section className="card">
        <h2>
          Result {result && <span className="card-title-note">{result.label} · HTTP {result.status}</span>}
        </h2>
        {!result && <p className="muted">Run an operation to see the response.</p>}
        {result?.status === 401 && (
          <Banner kind="warn" title="Session missing or expired">
            <a href="/api/auth/login?returnTo=%2Fgraphql">Log in again</a>.
          </Banner>
        )}
        {codes.includes("UNAUTHENTICATED") && <Banner kind="warn">The GraphQL API did not accept the token (UNAUTHENTICATED).</Banner>}
        {codes.includes("FORBIDDEN") && (
          <Banner kind="error" title="FORBIDDEN">
            Your roles do not allow this field. Roles come from the identity provider — sign in as <code>alice</code> for admin operations.
          </Banner>
        )}
        {result && <JsonPanel value={result.body} />}
      </section>
    </div>
  );
}

function extractCodes(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: { extensions?: { code?: string } }[] }).errors;
  return Array.isArray(errors) ? errors.map((e) => e.extensions?.code).filter((c): c is string => typeof c === "string") : [];
}
