.PHONY: engine desktop clean-engine

# Real Tauri app path
TAURI_DIR=apps/desktop/jobhunt/src-tauri
ENGINE_BIN_DIR=$(TAURI_DIR)/bin

# Tauri v2 sidecar name for Windows MSVC
ENGINE_WIN=$(ENGINE_BIN_DIR)/engine-x86_64-pc-windows-msvc.exe

engine:
	cd engine && go mod download
	# Build Windows sidecar where Tauri expects it
	cd engine && go build -o ../$(ENGINE_WIN) ./cmd/engine

clean-engine:
	# Kill any running engine processes so Windows doesn't lock the exe
	- taskkill /F /IM engine.exe 2>nul
	- taskkill /F /IM engine-x86_64-pc-windows-msvc.exe 2>nul
	- del /Q "$(ENGINE_WIN)" 2>nul

desktop: engine
	cd apps/desktop/jobhunt && npm install
	cd apps/desktop/jobhunt && npx tauri dev


