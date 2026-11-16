import {defineConfig, UserConfig} from "vite";
import react from "@vitejs/plugin-react";

const host = 'localhost';

// https://vite.dev/config/
export default defineConfig({
    base: './',

    plugins: [react()],

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
        },
    },
} as UserConfig);
