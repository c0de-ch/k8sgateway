import type { Metadata } from "next";
import { requirePageSession } from "@/lib/auth";
import { GraphqlClient } from "./graphql-client";

export const metadata: Metadata = { title: "GraphQL" };

export default async function GraphqlPage() {
  await requirePageSession("/graphql");
  return (
    <>
      <h1>GraphQL</h1>
      <p className="lead">
        A Client Component posting <code>{"{ query, variables }"}</code> to <code>/api/bff/graphql</code>; the BFF relays it to the GraphQL
        API with the bearer token. Errors come back as <code>extensions.code</code> UNAUTHENTICATED / FORBIDDEN.
      </p>
      <GraphqlClient />
    </>
  );
}
