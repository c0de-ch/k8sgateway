# syntax=docker/dockerfile:1
# Stage 1: build the Angular production bundle (Angular 22 needs Node >= 22.22.3 - pinned, a stale
# 'node:22-alpine' cache entry older than that fails the engines check)
FROM node:22.23.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# 'production' is the default configuration: hashed file names, optimisation, budgets
RUN npm run build

# Stage 2: static files served by nginx as a non-root user (uid 101) on port 8080
FROM nginxinc/nginx-unprivileged:1.30.5-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/angular-app/browser/ /usr/share/nginx/html/
# /usr/share/nginx/html/config.json is the default (mock IdP); Kubernetes mounts a ConfigMap over it (subPath)
EXPOSE 8080
