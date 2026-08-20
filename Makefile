# Toji. Plain `make` does the whole golden path: install, build, put the app in
# /Applications, and launch it. Everything else is a shortcut off that.

PM      := bun
APP     := Toji
DEST    := /Applications/$(APP).app
UNPACKED = release/mac-arm64/$(APP).app

.DEFAULT_GOAL := all
.PHONY: all deps app dev build install uninstall update check typecheck test dmg clean

all: install ## Install deps, build, install to /Applications, and launch

deps:
	@$(PM) install

build: deps ## Type-check and build the renderer + server bundles
	@$(PM) run build

app: build ## Package an unpacked .app (no installer)
	@bunx electron-builder --dir

install: app ## Put the app in /Applications and launch it
	@rm -rf "$(DEST)"
	@cp -R "$(UNPACKED)" "$(DEST)" 2>/dev/null || cp -R release/mac-*/$(APP).app "$(DEST)"
	@echo "installed $(DEST)"
	@open "$(DEST)"

uninstall: ## Quit the app and remove it from /Applications
	@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	@rm -rf "$(DEST)"
	@echo "removed $(DEST)"

update: uninstall install ## Stop, rebuild, reinstall, relaunch

dev: deps ## Run from source with hot reload (server + renderer + Electron)
	@$(PM) run dev

typecheck: ## Type-check only
	@$(PM) run typecheck

test: ## Run the unit tests
	@$(PM) run test

check: ## Full gate: typecheck + smoke + build + e2e
	@$(PM) run check

dmg: build ## Build a distributable .dmg and open it
	@bunx electron-builder --mac dmg
	@open release/*.dmg 2>/dev/null || true

clean: ## Remove build output
	@rm -rf dist release
