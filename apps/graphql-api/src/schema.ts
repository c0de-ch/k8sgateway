/**
 * GraphQL schema (SDL). Authorization is NOT expressed in the schema on purpose:
 * it is enforced in the resolvers (see resolvers.ts) so the rules are visible in code.
 *
 *   hello                 public
 *   me                    any authenticated user
 *   orders / createOrder  role "user"   (local in-memory store)
 *   restOrders            role "user"   (relays the caller's bearer token to the REST API)
 *   adminStats            role "admin"
 */
export const typeDefs = /* GraphQL */ `
  "Arbitrary JSON value (used to expose the raw token claims)."
  scalar JSON

  type Query {
    "Public — works without a token."
    hello: String!
    "Who am I? Requires a valid access token."
    me: Me
    "Orders from this service's in-memory store. Requires role \\"user\\"."
    orders: [Order!]!
    "Orders fetched from the REST API with the SAME bearer token (token relay). Requires role \\"user\\"."
    restOrders: [Order!]!
    "Requires role \\"admin\\"."
    adminStats: Stats!
  }

  type Mutation {
    "Create an order owned by the caller. Requires role \\"user\\"."
    createOrder(item: String!, quantity: Int!): Order!
  }

  type Me {
    sub: ID!
    name: String
    preferredUsername: String
    email: String
    "Raw values found at ROLES_CLAIM in the access token (may be empty)."
    roles: [String!]!
    "All verified access-token claims."
    claims: JSON!
  }

  type Order {
    id: ID!
    item: String!
    quantity: Int!
    owner: String!
    createdAt: String!
  }

  type Stats {
    orders: Int!
    users: Int!
    uptimeSeconds: Int!
  }
`;
