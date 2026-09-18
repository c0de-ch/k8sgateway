# Convenience wrapper around scripts/*.sh - run `make` for the list of targets.
.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

IDP ?= mock
APP ?= rest-api
# `make token USER=bob`; the shell's own $USER must not leak in as the default.
ifeq ($(origin USER),command line)
TOKEN_USER := $(USER)
else
TOKEN_USER := alice
endif
OVERLAYS := mock keycloak entra oracle

.PHONY: help up down build deploy switch test token urls logs tls lint

help: ## show this help
	@awk 'BEGIN{FS=":.*## "; printf "\nk8sgateway - JWT-protected apps on Kubernetes with a pluggable IdP\n\n"} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2} END{printf "\nvariables: IDP=mock|keycloak|entra|oracle  USER=alice|bob|carol  APP=rest-api|...  SCHEME=http|https\n           HTTP_PORT=8080 HTTPS_PORT=8443 when ports 80/443 cannot be bound (rootless Docker)\n\n"}' $(MAKEFILE_LIST)

up: ## create the kind cluster, install Envoy Gateway, build images, deploy IDP (default mock)
	IDP=$(IDP) scripts/up.sh

down: ## delete the kind cluster
	scripts/down.sh

build: ## build all application images and load them into kind (APPS="rest-api graphql-api" to limit)
	scripts/build.sh $(APPS)

deploy: ## (re)deploy the overlay for IDP=mock|keycloak|entra|oracle
	scripts/deploy.sh $(IDP)

switch: ## switch a running installation to IDP=... and restart the apps
	scripts/switch-idp.sh $(IDP)

test: ## curl smoke tests against the running installation
	scripts/test.sh

token: ## print an access token for USER=alice|bob|carol (add DECODE=1 to decode it)
	scripts/get-token.sh $(if $(DECODE),--decode,) $(TOKEN_USER)

urls: ## print the URLs and demo users
	scripts/urls.sh

logs: ## tail the logs of APP=rest-api|graphql-api|angular-app|nextjs-app|mock-idp|keycloak|envoy
	scripts/logs.sh $(APP)

tls: ## optional: local CA + wildcard cert + https listener on the Gateway
	scripts/tls-setup.sh

lint: ## render every overlay (kubectl kustomize), kubeconform + shellcheck if installed
	@set -e; export PATH="$$HOME/.local/bin:$$PATH"; \
	for o in $(OVERLAYS); do \
	  printf 'kustomize %-9s ' $$o; kubectl kustomize deploy/overlays/$$o > /tmp/k8sgateway-$$o.yaml && echo ok; \
	  if command -v kubeconform >/dev/null; then kubeconform -strict -ignore-missing-schemas -summary /tmp/k8sgateway-$$o.yaml; fi; \
	done; \
	for f in deploy/gateway-policies/*.yaml deploy/tls/gateway-https.yaml; do printf 'yaml %-40s ' $$f; kubectl apply --dry-run=client -f $$f > /dev/null && echo ok; done; \
	for f in scripts/*.sh; do bash -n $$f; done && echo "bash -n scripts/*.sh ok"; \
	if command -v shellcheck >/dev/null; then shellcheck -x scripts/*.sh && echo "shellcheck ok"; else echo "shellcheck not installed - skipped"; fi
