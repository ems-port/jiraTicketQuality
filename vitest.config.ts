import { webcrypto } from "node:crypto";
import path from "node:path";
import { defineConfig } from "vitest/config";

if (typeof globalThis.crypto === "undefined") {
  // Vitest server creation needs crypto before setup files run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, ".")
    }
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup-vitest.ts"]
  }
});
