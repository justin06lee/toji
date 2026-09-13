# Toji. Plain `make` does the whole golden path: build the browser from Firefox
# ESR source (gecko/build.ts), reset the old bundle's macOS permissions, put
# Toji.app in /Applications and launch it. The first build takes hours; later
# ones reuse the objdir and sccache.

PM        := bun
APP       := Toji
DEST      ?= /Applications/$(APP).app
BUNDLE_ID := com.ezzy.toji
GECKO     := $(PM) gecko/build.ts

.DEFAULT_GOAL := all
.PHONY: all deps build install update stop reset-permissions uninstall dev faster run check test typecheck tor-check linux clean \
	electron electron-dev electron-install

all: install ## Build, reset permissions, install to /Applications, launch

deps:
	@$(PM) install

build: ## Build and package Toji.app (gecko/.work/obj/dist/toji/Toji.app)
	@$(GECKO) app

# Quits by path, not bundle id: the Electron app shares com.ezzy.toji until it
# is retired, and a test build elsewhere must not be touched either.
stop: ## Quit the installed app and wait until it has exited
	@osascript -e 'tell application "$(DEST)" to quit' 2>/dev/null || true
	@i=0; while pgrep -f "$(DEST)/Contents/MacOS/" >/dev/null && [ $$i -lt 100 ]; do sleep 0.1; i=$$((i + 1)); done; \
		if pgrep -f "$(DEST)/Contents/MacOS/" >/dev/null; then echo "error: $(APP) did not quit; refusing to replace a running app" >&2; exit 1; fi

# A rebuilt bundle has a new ad-hoc signature, so macOS keeps showing the old
# grants while ignoring them. Clear Toji's entries so the new build asks afresh.
reset-permissions:
	@osascript -e 'quit app "System Settings"' 2>/dev/null || true
	@for s in Camera Microphone ScreenCapture SystemPolicyAllFiles; do tccutil reset $$s $(BUNDLE_ID) >/dev/null 2>&1 || true; done

install: build stop reset-permissions ## Install the built app to $(DEST) and launch it
	@$(GECKO) install "$(DEST)"
	@open "$(DEST)"

update: stop ## Stop, delete, rebuild, reinstall, relaunch
	@rm -rf "$(DEST)"
	@$(MAKE) --no-print-directory install

uninstall: stop ## Quit the app and remove it
	@rm -rf "$(DEST)"
	@echo "removed $(DEST)"

faster: ## Rebuild only front-end files (JS, CSS, prefs) into the objdir
	@$(GECKO) faster

dev: faster ## Front-end rebuild, then run the unpackaged build with a scratch profile
	@$(GECKO) run

run: ## Run the packaged build with a scratch profile
	@$(GECKO) run

typecheck:
	@$(PM) run typecheck

test: ## Unit tests (Vitest)
	@$(PM) run test

check: ## Typecheck, unit tests, and the phase and shell checks against the built app
	@$(PM) run typecheck
	@$(PM) run test
	@$(PM) gecko/test/phase1.ts --idle 60
	@$(PM) gecko/test/shell.ts

tor-check: ## Live Tor check against a real daemon (needs: brew install tor)
	@$(PM) run tor:check

linux: ## Linux packages (see docs/gecko.md, "Linux")
	@echo "Linux builds of the Gecko browser: see docs/gecko.md (Linux)." >&2; exit 1

clean: ## Remove the objdir (keeps the source tree and the download cache)
	@rm -rf gecko/.work/obj dist release

# --- The Electron app, kept until phase 8 of docs/gecko.md retires it -------
ELECTRON_UNPACKED = release/mac-arm64/$(APP).app

electron: deps ## Build the Electron app bundle (legacy)
	@$(PM) run build
	@bunx electron-builder --dir

electron-dev: deps ## Run the Electron app from source (legacy)
	@$(PM) run dev

electron-install: electron stop ## Install the Electron app to $(DEST) (legacy)
	@rm -rf "$(DEST)"
	@cp -R "$(ELECTRON_UNPACKED)" "$(DEST)" 2>/dev/null || cp -R release/mac-*/$(APP).app "$(DEST)"
	@open "$(DEST)"
