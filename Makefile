# Toji — common tasks. Run `make <target>`.
# Uses bun (the project's package manager).

PM := bun

.DEFAULT_GOAL := help
.PHONY: help install setup dev build typecheck check dmg app dir clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(PM) install

setup: install ## Install dependencies and the Chromium browser for research
	$(PM) run setup:browsers

dev: ## Run the full app in development (server + renderer + electron)
	$(PM) run dev

build: ## Type-check and build the renderer + server bundles
	$(PM) run build

typecheck: ## Type-check only
	$(PM) run typecheck

check: ## Full gate: typecheck + smoke + build + e2e
	$(PM) run check

dmg: build ## Build a distributable .dmg installer (drag-to-Applications) and open it
	bunx electron-builder --mac dmg
	@echo "Opening installer…"
	@open release/*.dmg 2>/dev/null || true

dir: build ## Build an unpacked .app folder (no installer)
	bunx electron-builder --dir

app: dir ## Alias for `dir`

clean: ## Remove build output
	rm -rf dist release
