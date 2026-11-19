// Copyright 2026 Alex Degner (alex@ergofox.me)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {defineConfig, UserConfig} from "vite";

const host = 'localhost';

// https://vite.dev/config/
// react* imports (including dependencies') resolve to the Preact compat layer.
const aliases = {
    "react-dom/client": "preact/compat/client",
    "react-dom": "preact/compat",
    "react/jsx-dev-runtime": "preact/compat/jsx-dev-runtime",
    "react/jsx-runtime": "preact/compat/jsx-runtime",
    react: "preact/compat",
};

export default defineConfig({
    base: './',

    resolve: {
        alias: aliases,
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    build: {
        outDir: 'dist',
    },
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 9999,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: "ws",
                host,
                port: 9999,
            }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
            // 4. inotify events are unreliable through the Docker bind mount
            //    (edits were sometimes missed, serving stale modules) — poll
            //    the filesystem instead.
            usePolling: true,
            interval: 300,
        },
    },
} as UserConfig);
