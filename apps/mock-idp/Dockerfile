# Development OIDC provider. Plain JavaScript, no build step: a single stage is enough.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Install exactly the locked dependency tree (express + jose), nothing else.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY users.json clients.json ./

# Run as the unprivileged "node" user shipped with the base image. The numeric form matters:
# Kubernetes can only verify `runAsNonRoot: true` against a numeric UID, not against a name.
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/server.js"]
