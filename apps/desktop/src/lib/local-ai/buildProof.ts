// Nonshipping single-asset build with the application's real rune compiler.
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import process from "node:process";

await build({
  configFile: false,
  plugins: [svelte({ hot: false })],
  logLevel: "error",
  resolve: {
    conditions: ["browser"],
    alias: { $lib: fileURLToPath(new URL("../", import.meta.url)) },
  },
  build: {
    outDir: process.argv[2],
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("proof.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "proof.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
