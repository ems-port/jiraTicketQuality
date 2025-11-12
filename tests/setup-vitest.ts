import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
  // Vitest in Node 18 does not attach webcrypto by default; attach it for libraries that expect browser crypto.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}
