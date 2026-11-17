# Transcriber build commands. All Rust builds run inside the transcriber
# container: the toolchain (CUDA, nvcc) lives in the image, not on the host.
# Artifacts land in src-tauri/target and are host-visible through the /srv
# mount.

TAURI_DIR := transcriber/src-tauri

# Deferred (`=`) on purpose: the wildcard must resolve AFTER the build runs,
# when the freshly built artifact exists.
APPIMAGE = $(wildcard $(TAURI_DIR)/target/release/bundle/appimage/*.AppImage)
APPIMAGE_FILE = $(shell find $(TAURI_DIR)/target/release/bundle/appimage -maxdepth 1 -name 'Transcriber*.AppImage' | head -1)

# App version from tauri.conf.json, used for the GitHub release tag.
VERSION = $(shell grep -oP '(?<="version": ")[^"]+' $(TAURI_DIR)/tauri.conf.json | head -1)

DIST = dist
DIST_APPIMAGE = $(DIST)/Transcriber-$(VERSION)-linux-x86_64.AppImage

# All builds share target/ (including the runtime bundle directory), so they
# are serialized with flock: parallel invocations wait instead of racing.
LOCK := /tmp/transcriber-build.lock

.PHONY: help appimage dev clean clean-all release upload

help:
	@echo "make appimage  - desktop AppImage (models + CUDA runtime bundle)"
	@echo "make dev           - dev environment (frontend + cargo tauri dev)"
	@echo "make clean         - remove debug build caches (release kept)"
	@echo "make clean-all     - remove the whole target directory"
	@echo "make release       - publish the AppImage as a GitHub release (gh)"
	@echo "make upload        - re-upload the artifact to the existing release"

# Desktop: release build packaged as an AppImage, then repacked with the
# models (all ggml files from models/) bundled next to the binary. The CUDA
# runtime libs are added by linuxdeploy automatically.
appimage:
	flock $(LOCK) docker compose run --rm transcriber sh -c "cd /srv/src-tauri && cargo tauri build --bundles appimage"
	flock $(LOCK) docker compose run --rm transcriber sh -c "\
	  cd /srv/src-tauri/target/release/bundle/appimage && \
	  rm -rf squashfs-root && \
	  ./Transcriber_$(VERSION)_amd64.AppImage --appimage-extract >/dev/null && \
	  mkdir -p squashfs-root/usr/bin/models && \
	  cp -a /srv/src-tauri/models/*.bin squashfs-root/usr/bin/models/ && \
	  rm -f *.AppImage && \
	  test -x appimagetool.AppImage || wget -qO appimagetool.AppImage https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage && \
	  chmod +x appimagetool.AppImage && \
	  ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ./appimagetool.AppImage squashfs-root Transcriber_$(VERSION)_amd64-full.AppImage"
	@echo "Artifact: $(APPIMAGE)"

# Dev environment: starts the vite dev server and cargo tauri dev.
dev:
	docker compose up frontend transcriber

# Remove the debug build caches. Runs in the container because the build
# files are created by root; release artifacts are kept.
clean:
	flock $(LOCK) docker compose run --rm transcriber sh -c "rm -rf /srv/src-tauri/target/debug /srv/src-tauri/target/*/debug"

# Remove the whole target directory: the next build recompiles everything.
clean-all:
	flock $(LOCK) docker compose run --rm transcriber sh -c "rm -rf /srv/src-tauri/target"

# Copy the release artifact to dist/ with a clean name and publish it as a
# GitHub release (tag v$(VERSION) is created at the current HEAD). Requires
# the gh CLI logged in (`gh auth login`). Run `make appimage` first so the
# artifact exists.
release:
	@mkdir -p $(DIST)
	gh release create v$(VERSION) "$(APPIMAGE_FILE)" \
		--title "Transcriber $(VERSION)" --generate-notes
	@echo "Release v$(VERSION) published."

# Re-upload the artifact to the existing release, replacing the old file.
upload:
	@mkdir -p $(DIST)
	gh release upload v$(VERSION) "$(APPIMAGE_FILE)" --clobber
	@echo "Artifact uploaded to release v$(VERSION)."
