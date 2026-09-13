import { describe, expect, it } from "vitest";
import { bundledReleaseNotes } from "../apps/desktop/src/lib/update/bundledReleaseNotes.ts";

import { verifyReleaseVersion } from "./verify-release-version.ts";

const canonicalNotes = "### Changed\n\n- First public release.";
const validContract = {
  tag: "v0.1.0",
  tauriConfig: JSON.stringify({ version: "0.1.0" }),
  packageJson: JSON.stringify({ name: "tesina", version: "0.1.0" }),
  cargoToml: `[package]\nname = "tesina"\nversion = "0.1.0"\n`,
  cargoLock:
    `version = 4\n\n[[package]]\nname = "tesina"\nversion = "0.1.0"\ndependencies = []\n`,
  changelog: `# Changelog\n\n## [0.1.0] - 2026-08-07\n\n${canonicalNotes}\n`,
};

describe("verifyReleaseVersion", () => {
  it("accepts one version shared by the tag, app metadata, and changelog", () => {
    expect(verifyReleaseVersion(validContract)).toEqual({
      version: "0.1.0",
      notes: canonicalNotes,
    });
  });

  it("requires an exact v-prefixed release tag", () => {
    expect(() => verifyReleaseVersion({ ...validContract, tag: "0.1.0" }))
      .toThrow('Release tag must start with "v"; received "0.1.0".');
  });

  it.each([
    ["Tauri", "tauriConfig", JSON.stringify({ version: "0.1.1" })],
    ["package", "packageJson", JSON.stringify({ version: "0.1.1" })],
    [
      "Cargo",
      "cargoToml",
      `[package]\nname = "tesina"\nversion = "0.1.1"\n`,
    ],
    [
      "Cargo.lock Tesina package",
      "cargoLock",
      `version = 4\n\n[[package]]\nname = "tesina"\nversion = "0.1.1"\n`,
    ],
  ])("rejects a mismatched %s version", (label, field, value) => {
    expect(() =>
      verifyReleaseVersion({
        ...validContract,
        [field]: value,
      })
    ).toThrow(`${label} version must be "0.1.0"`);
  });

  it("requires a nonempty matching changelog section", () => {
    expect(() =>
      verifyReleaseVersion({
        ...validContract,
        changelog: "## [0.1.1]\n\n- Later.\n",
      })
    ).toThrow('No changelog section found for version "0.1.0".');
  });

  it("reads only the package table version from Cargo.toml", () => {
    expect(
      verifyReleaseVersion({
        ...validContract,
        cargoToml:
          `[workspace.package]\nversion = "9.9.9"\n\n[package]\nname = "tesina"\nversion = "0.1.0"\n\n[dependencies]\nexample = { version = "3.0.0" }\n`,
      }),
    ).toEqual({ version: "0.1.0", notes: canonicalNotes });
  });

  it("requires exactly one versioned Tesina package in Cargo.lock", () => {
    expect(() =>
      verifyReleaseVersion({
        ...validContract,
        cargoLock: `[[package]]\nname = "other"\nversion = "0.1.0"\n`,
      })
    ).toThrow('Cargo.lock must contain exactly one "tesina" package');

    expect(() =>
      verifyReleaseVersion({
        ...validContract,
        cargoLock: `${validContract.cargoLock}\n${validContract.cargoLock}`,
      })
    ).toThrow('Cargo.lock must contain exactly one "tesina" package');
  });

  it("reads Cargo.lock metadata with Windows line endings", () => {
    expect(
      verifyReleaseVersion({
        ...validContract,
        cargoLock: validContract.cargoLock.replaceAll("\n", "\r\n"),
      }),
    ).toEqual({ version: "0.1.0", notes: canonicalNotes });
  });

  it("writes exact verified notes and leaves no stale output after failure", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "tesina-release-version-",
    });
    const paths = {
      tauri: `${directory}/tauri.conf.json`,
      package: `${directory}/package.json`,
      cargo: `${directory}/Cargo.toml`,
      lock: `${directory}/Cargo.lock`,
      changelog: `${directory}/CHANGELOG.md`,
      notes: `${directory}/notes.md`,
    };

    try {
      await Promise.all([
        Deno.writeTextFile(paths.tauri, validContract.tauriConfig),
        Deno.writeTextFile(paths.package, validContract.packageJson),
        Deno.writeTextFile(paths.cargo, validContract.cargoToml),
        Deno.writeTextFile(paths.lock, validContract.cargoLock),
        Deno.writeTextFile(paths.changelog, validContract.changelog),
      ]);
      const runVerifier = () =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--quiet",
            "--allow-read",
            `--allow-write=${paths.notes}`,
            new URL("./verify-release-version.ts", import.meta.url).pathname,
            validContract.tag,
            paths.tauri,
            paths.package,
            paths.cargo,
            paths.lock,
            paths.changelog,
            paths.notes,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
      const result = await runVerifier();

      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.code).toBe(0);
      expect(await Deno.readTextFile(paths.notes)).toBe(canonicalNotes);

      await Deno.writeTextFile(paths.notes, "Stale notes");
      await Deno.writeTextFile(
        paths.lock,
        validContract.cargoLock.replace(
          'version = "0.1.0"',
          'version = "9.9.9"',
        ),
      );
      const failure = await runVerifier();

      expect(failure.code).toBe(1);
      await expect(Deno.stat(paths.notes)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("matches the real 0.1.24 metadata, README, links, and bundled Markdown", async () => {
    const root = new URL("../", import.meta.url);
    const [
      tauriConfig,
      packageJson,
      cargoToml,
      cargoLock,
      changelog,
      readme,
      englishMessages,
      spanishMessages,
    ] = await Promise.all([
      Deno.readTextFile(
        new URL("apps/desktop/src-tauri/tauri.conf.json", root),
      ),
      Deno.readTextFile(new URL("apps/desktop/package.json", root)),
      Deno.readTextFile(new URL("apps/desktop/src-tauri/Cargo.toml", root)),
      Deno.readTextFile(new URL("apps/desktop/src-tauri/Cargo.lock", root)),
      Deno.readTextFile(new URL("CHANGELOG.md", root)),
      Deno.readTextFile(new URL("README.md", root)),
      Deno.readTextFile(new URL("apps/desktop/messages/en.json", root)),
      Deno.readTextFile(new URL("apps/desktop/messages/es.json", root)),
    ]);

    const verified = verifyReleaseVersion({
      tag: "v0.1.24",
      tauriConfig,
      packageJson,
      cargoToml,
      cargoLock,
      changelog,
    });

    expect(verified.version).toBe(bundledReleaseNotes.version);
    expect(verified.notes).toBe(bundledReleaseNotes.body);
    expect(readme).toContain("Version 0.1.24 supports");
    expect(readme).toContain(
      "deterministic English and Spanish writing feedback",
    );
    expect(readme).toMatch(/never\s+rewrites\s+the paper automatically/);
    expect(changelog).toContain(
      "[Unreleased]: https://github.com/adominicci/tesina/compare/v0.1.24...HEAD",
    );
    expect(changelog).toContain(
      "[0.1.24]: https://github.com/adominicci/tesina/compare/v0.1.23...v0.1.24",
    );
    expect(changelog).toContain(
      "[0.1.23]: https://github.com/adominicci/tesina/compare/v0.1.22...v0.1.23",
    );
    expect(changelog).toContain(
      "[0.1.22]: https://github.com/adominicci/tesina/compare/v0.1.21...v0.1.22",
    );
    expect(changelog).toContain(
      "[0.1.21]: https://github.com/adominicci/tesina/compare/v0.1.20...v0.1.21",
    );
    expect(changelog).toContain(
      "[0.1.20]: https://github.com/adominicci/tesina/compare/v0.1.19...v0.1.20",
    );
    expect(changelog).toContain(
      "[0.1.19]: https://github.com/adominicci/tesina/compare/v0.1.18...v0.1.19",
    );
    expect(changelog).toContain(
      "[0.1.16]: https://github.com/adominicci/tesina/compare/v0.1.15...v0.1.16",
    );
    expect(changelog).toContain(
      "[0.1.15]: https://github.com/adominicci/tesina/compare/v0.1.14...v0.1.15",
    );
    expect(changelog).toContain(
      "[0.1.14]: https://github.com/adominicci/tesina/compare/v0.1.12...v0.1.14",
    );
    expect(changelog).toContain(
      "[0.1.13]: https://github.com/adominicci/tesina/commit/80443091b75b1a887b01fdca12c09e565807a10a",
    );
    for (const source of [englishMessages, spanishMessages]) {
      const messages = JSON.parse(source) as Record<string, string>;
      expect(messages.bk_reauthorization_body).toContain("v{version}");
      expect(messages.bk_reauthorization_body).not.toContain("v0.1.20");
    }
  });
});
