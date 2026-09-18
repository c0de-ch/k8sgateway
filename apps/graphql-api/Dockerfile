# syntax=docker/dockerfile:1
# Stage 1 — compile TypeScript with the dev toolchain
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2 — runtime: production dependencies only, non-root, port 4000
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# The official image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
