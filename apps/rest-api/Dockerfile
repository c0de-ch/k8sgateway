# syntax=docker/dockerfile:1
# Stage 1: build a static binary (no host Go toolchain needed).
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# Stage 2: distroless static image - no shell, no package manager, runs as uid 65532.
# It ships ca-certificates and sets SSL_CERT_FILE, so https JWKS (Entra, Oracle) work.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/api /api
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/api"]
