.PHONY: engine desktop

ENGINE_OUT=apps/desktop/src-tauri/bin

engine:
	cd engine && go mod download
	# Windows
	cd engine && GOOS=windows GOARCH=amd64 go build -o ../$(ENGINE_OUT)/engine.exe ./cmd/engine
	# macOS (Apple Silicon)
	cd engine && GOOS=darwin GOARCH=arm64 go build -o ../$(ENGINE_OUT)/engine ./cmd/engine
	# Linux
	cd engine && GOOS=linux GOARCH=amd64 go build -o ../$(ENGINE_OUT)/engine ./cmd/engine

desktop: engine
	cd apps/desktop && npm install
	cd apps/desktop && npm run tauri dev

