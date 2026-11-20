# Copyright 2026 Alex Degner (alex@ergofox.me)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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

# Shorthand: every Rust-side command runs inside the transcriber container,
# serialized by the build lock.
RUN = flock $(LOCK) docker compose run --rm transcriber

.PHONY: help appimage dev clean-all clean-docker release upload

help:
	@echo "make appimage  - desktop AppImage (models + CUDA runtime bundle)"
	@echo "make dev           - dev environment (frontend + cargo tauri dev)"
	@echo "make clean-all     - all builds (debug, release, dist) + docker cleanup + prune"
	@echo "make clean-docker  - remove transcriber containers, images and volumes"
	@echo "make release       - publish the AppImage as a GitHub release (gh)"
	@echo "make upload        - re-upload the artifact to the existing release"

# Desktop: release build packaged as an AppImage, then repacked with the
# models (all ggml files from models/) bundled next to the binary. The CUDA
# runtime libs are added by linuxdeploy automatically.
appimage:
	$(RUN) sh -c "cd /srv/src-tauri && cargo tauri build --bundles appimage"
	$(RUN) sh -c "\
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

# Docker cleanup for this project: containers (dev + one-off run sessions),
# networks, project images and volumes (models and caches are re-downloaded
# on the next build).
clean-docker:
	@echo ">> removing containers, networks and volumes"
	docker compose down --remove-orphans --volumes 2>/dev/null || true
	docker rm -f $$(docker ps -aq --filter "name=transcriber") 2>/dev/null || true
	@echo ">> removing project images"
	docker rmi -f $$(docker images -q "transcriber-*") 2>/dev/null || true

# Full wipe: the whole target directory plus the docker resources of this
# project (reuses clean-docker), then a complete docker system prune — all
# unused images, stopped containers, networks and the build cache. Affects
# the whole docker host, not just this project. Everything re-downloads on
# the next build.
clean:
	$(RUN) sh -c "rm -rf /srv/src-tauri/target"
	rm -rf $(DIST) $(TAURI_DIR)/target/release/bundle/appimage/squashfs-root
	$(MAKE) --no-print-directory clean-docker
	@echo ">> full docker system prune (all unused images + build cache)"
	docker system prune -af 2>/dev/null || true
	@echo ">> disk usage after cleanup:"
	@docker system df

# The dist/ folder for the release artifacts (created on demand).
$(DIST):
	mkdir -p $(DIST)

# Copy the release artifact to dist/ with a clean name and publish it as a
# GitHub release (tag v$(VERSION) is created at the current HEAD). Requires
# the gh CLI logged in (`gh auth login`). Run `make appimage` first so the
# artifact exists.
release: | $(DIST)
	gh release create v$(VERSION) "$(APPIMAGE_FILE)" \
		--title "Transcriber $(VERSION)" --generate-notes
	@echo "Release v$(VERSION) published."

# Re-upload the artifact to the existing release, replacing the old file.
upload: | $(DIST)
	gh release upload v$(VERSION) "$(APPIMAGE_FILE)" --clobber
	@echo "Artifact uploaded to release v$(VERSION)."
