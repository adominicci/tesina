import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeBoundedProcess } from "./proofProcess.ts";

interface CargoMetadata {
  packages: Array<{
    name: string;
    dependencies: Array<{
      name: string;
      kind: string | null;
      req: string;
    }>;
    targets: Array<{
      name: string;
      kind: string[];
      crate_types: string[];
    }>;
  }>;
}

const proofDir = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(proofDir, "../../../../../src-tauri");

async function cargoMetadata(): Promise<CargoMetadata> {
  const output = await executeBoundedProcess(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version=1",
      "--no-deps",
      "--manifest-path",
      resolve(tauriDir, "Cargo.toml"),
    ],
    { timeoutMs: 15_000 },
  );
  if (output.code !== 0) {
    throw new Error(`cargo metadata failed: ${output.stderr.trim()}`);
  }
  return JSON.parse(output.stdout) as CargoMetadata;
}

describe("Windows native pagination host containment", () => {
  it(
    "builds only as a test example from the already-locked Tao/Wry backend",
    { timeout: 25_000 },
    async () => {
      const metadata = await cargoMetadata();
      const tesina = metadata.packages.find((entry) => entry.name === "tesina");
      expect(tesina).toBeDefined();

      const target = tesina?.targets.find((entry) =>
        entry.name === "webview2-proof-host"
      );
      expect(target).toMatchObject({
        kind: ["example"],
        crate_types: ["bin"],
      });
      expect(tesina?.targets.filter((entry) => entry.kind.includes("bin")))
        .toEqual(
          [expect.objectContaining({ name: "tesina" })],
        );

      expect(tesina?.dependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "tao",
          kind: "dev",
          req: "=0.35.3",
        }),
        expect.objectContaining({
          name: "url",
          // Shared with the native public-reference URL policy (LT-05).
          kind: null,
          req: "=2.5.8",
        }),
        expect.objectContaining({
          name: "wry",
          kind: "dev",
          req: "=0.55.1",
        }),
      ]));
    },
  );
});
