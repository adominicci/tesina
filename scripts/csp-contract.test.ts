import { describe, expect, it } from "vitest";

const config = JSON.parse(
  await Deno.readTextFile(
    new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
  ),
) as {
  app?: {
    security?: {
      csp?: unknown;
      devCsp?: unknown;
      dangerousDisableAssetCspModification?: unknown;
    };
  };
};
const capability = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../apps/desktop/src-tauri/capabilities/default.json",
      import.meta.url,
    ),
  ),
) as { permissions?: unknown[] };

const productionPolicy = {
  "base-uri": ["'none'"],
  "connect-src": ["ipc:", "http://ipc.localhost", "blob:"],
  "default-src": ["'self'"],
  "font-src": ["'self'", "data:"],
  "form-action": ["'none'"],
  "frame-src": ["'none'"],
  "img-src": ["'self'", "blob:", "data:"],
  "object-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'", "blob:"],
};

describe("desktop CSP contract", () => {
  it("restricts the packaged webview to required local and Tauri sources", () => {
    const security = config.app?.security;
    expect(security?.csp).toEqual(productionPolicy);
    expect(security?.dangerousDisableAssetCspModification).toEqual([
      "style-src",
    ]);

    const serialized = JSON.stringify(security?.csp);
    expect(serialized).not.toContain("https:");
    expect(serialized).not.toContain("ws:");
    expect(serialized).not.toContain("asset:");
    expect(serialized).not.toContain("tesina-print:");
    expect(productionPolicy["script-src"]).not.toContain("'unsafe-inline'");
    expect(productionPolicy["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("allows Vite HMR only in the development policy", () => {
    expect(config.app?.security?.devCsp).toEqual({
      ...productionPolicy,
      "connect-src": [
        "'self'",
        "ipc:",
        "http://ipc.localhost",
        "blob:",
        "ws:",
      ],
    });
  });

  it("does not grant generic HTTP authority to the webview", () => {
    expect(capability.permissions).toBeDefined();
    expect(JSON.stringify(capability.permissions)).not.toContain("http:");
  });
});
