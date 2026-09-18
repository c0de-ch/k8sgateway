import type { Metadata } from "next";
import { requirePageSession } from "@/lib/auth";
import { OrdersClient } from "./orders-client";

export const metadata: Metadata = { title: "Orders" };

/** The page itself re-verifies the session; the interactive table is a Client Component using /api/bff/orders. */
export default async function OrdersPage() {
  await requirePageSession("/orders");
  return (
    <>
      <h1>Orders</h1>
      <p className="lead">
        A Client Component calling <code>/api/bff/orders</code> with the session cookie. The BFF relays each call to the REST API with the
        bearer token (requires the <code>user</code> role).
      </p>
      <OrdersClient />
    </>
  );
}
