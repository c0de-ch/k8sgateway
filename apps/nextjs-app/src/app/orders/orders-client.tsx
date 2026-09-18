"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiStatusBanner, Banner } from "@/components/banner";

interface Order {
  id: string;
  item: string;
  quantity: number;
  owner: string;
  createdAt: string;
}

interface Result {
  status: number;
  body: unknown;
}

async function callBff(path: string, init?: RequestInit): Promise<Result> {
  const res = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

export function OrdersClient() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [status, setStatus] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [item, setItem] = useState("coffee beans");
  const [quantity, setQuantity] = useState(1);

  // State updates happen in the promise callback (after the fetch), not synchronously inside the effect.
  const load = useCallback(
    () =>
      callBff("/api/bff/orders").then((r) => {
        setStatus(r.status);
        setOrders(r.status === 200 && Array.isArray(r.body) ? (r.body as Order[]) : null);
      }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await callBff("/api/bff/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item, quantity }),
    });
    setBusy(false);
    if (r.status === 201 || r.status === 200) {
      setMessage(`Created order for ${quantity} × ${item}`);
      await load();
    } else {
      setStatus(r.status);
      const b = r.body as { error_description?: string; error?: string } | string;
      setMessage(typeof b === "string" ? b : (b.error_description ?? b.error ?? `HTTP ${r.status}`));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>New order</h2>
        <form className="inline" onSubmit={create}>
          <label>
            Item
            <input value={item} onChange={(e) => setItem(e.target.value)} required maxLength={60} />
          </label>
          <label>
            Quantity
            <input type="number" min={1} max={1000} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Sending…" : "POST /api/bff/orders"}
          </button>
        </form>
        {message && <p className="muted small">{message}</p>}
      </section>

      <section className="card">
        <h2>
          Your orders <span className="card-title-note">GET /api/bff/orders → REST /api/orders</span>
        </h2>
        {status > 0 && <p className="status-code">HTTP {status}</p>}
        <ApiStatusBanner status={status} returnTo="/orders" requiredRole="user" />
        {orders === null && status === 0 && <p className="muted">Loading…</p>}
        {orders && orders.length === 0 && <Banner kind="info">No orders yet — create one above.</Banner>}
        {orders && orders.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Owner</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.id}</td>
                  <td>{o.item}</td>
                  <td>{o.quantity}</td>
                  <td>{o.owner}</td>
                  <td className="mono small">{o.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
