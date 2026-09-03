# Toji. Plain `make` does the whole golden path: install, build, put the app in
# /Applications, and launch it. Everything else is a shortcut off that.

PM      := bun
APP     := Toji
DEST    := /Applications/$(APP).app
UNPACKED = release/mac-arm64/$(APP).app

.DEFAULT_GOAL := all
.PHONY: all deps app dev build stop install uninstall update check tor-check typecheck test dmg linux clean

all: install ## Install deps, build, install to /Applications, and launch

deps:
	@$(PM) install

build: deps ## Type-check and build the renderer + server bundles
	@$(PM) run build

app: build ## Package an unpacked .app (no installer)
	@bunx electron-builder --dir

stop: ## Stop the installed app and wait until its main process exits
	@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	@i=0; while pgrep -x "$(APP)" >/dev/null && [ $$i -lt 100 ]; do sleep 0.1; i=$$((i + 1)); done; \
		if pgrep -x "$(APP)" >/dev/null; then echo "error: $(APP) did not quit; refusing to replace a running app" >&2; exit 1; fi

install: app stop ## Put the app in /Applications and launch it
	@rm -rf "$(DEST)"
	@cp -R "$(UNPACKED)" "$(DEST)" 2>/dev/null || cp -R release/mac-*/$(APP).app "$(DEST)"
	@echo "installed $(DEST)"
	@open "$(DEST)"
	@i=0; until curl -fsS http://127.0.0.1:8788/health >/dev/null 2>&1 || [ $$i -ge 100 ]; do sleep 0.2; i=$$((i + 1)); done; \
		if ! curl -fsS http://127.0.0.1:8788/health >/dev/null 2>&1; then echo "error: $(APP) launched but its local server did not become healthy" >&2; exit 1; fi

uninstall: stop ## Quit the app and remove it from /Applications
	@rm -rf "$(DEST)"
	@echo "removed $(DEST)"

update: uninstall install ## Stop, rebuild, reinstall, relaunch

dev: deps ## Run from source with hot reload (server + renderer + Electron)
	@$(PM) run dev

typecheck: ## Type-check only
	@$(PM) run typecheck

test: ## Run the unit tests
	@$(PM) run test

tor-check: ## Live Tor check against a real daemon (needs: brew install tor)
	@$(PM) run tor:check

check: ## Full gate: typecheck + smoke + build + e2e
	@$(PM) run check

dmg: build ## Build a distributable .dmg and open it
	@bunx electron-builder --mac dmg
	@open release/*.dmg 2>/dev/null || true

linux: build ## Build the Linux packages (AppImage + deb, x64 and arm64)
	@bunx electron-builder --linux --x64 --arm64

clean: ## Remove build output
	@rm -rf dist release
