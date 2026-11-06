import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    // The emulator (?emulate) is imported on demand; listing it here bundles it
    // up front, instead of Vite discovering it mid-load and reloading the page.
    optimizeDeps: {
        include: ["iwer", "@iwer/sem", "@iwer/devui"],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        // three.js alone is about 600 kB; one bundle is fine for this app.
        chunkSizeWarningLimit: 1024,
    },
});
