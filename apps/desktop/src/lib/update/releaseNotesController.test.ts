import { describe, expect, it, vi } from "vitest";
import {
  type BundledReleaseNotes,
  bundledReleaseNotes,
} from "./bundledReleaseNotes.ts";
import {
  createReleaseNotesController,
  type ReleaseNotesController,
} from "./releaseNotesController.svelte.ts";
import {
  readPendingReleaseNotes,
  type ReleaseNotesStorage,
  savePendingReleaseNotes,
} from "./releaseNotes.ts";

class MemoryStorage implements ReleaseNotesStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const bundled: BundledReleaseNotes = Object.freeze({
  version: "0.2.0",
  body: "### Changed\n\n- Canonical bundled notes.",
});

function controller(
  getRuntimeVersion: () => Promise<unknown>,
  storage: ReleaseNotesStorage | null = new MemoryStorage(),
): ReleaseNotesController {
  return createReleaseNotesController({
    bundled,
    getRuntimeVersion,
    getStorage: () => storage,
    unavailableBody: () => "Release notes are unavailable for this version.",
  });
}

describe("release notes controller", () => {
  it("uses the exact canonical 0.1.23 Markdown for automatic and manual presentation", async () => {
    expect(bundledReleaseNotes.version).toBe("0.1.23");
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: bundledReleaseNotes.version,
      body: "Legacy updater body must not replace canonical notes.",
    });
    const notes = createReleaseNotesController({
      bundled: bundledReleaseNotes,
      getRuntimeVersion: () => Promise.resolve(bundledReleaseNotes.version),
      getStorage: () => storage,
      unavailableBody: () => "Release notes unavailable.",
    });
    notes.setUiReady(true);
    await notes.resolveRuntimeVersion();

    expect(notes.presentation).toEqual({
      kind: "automatic",
      version: "0.1.23",
      body: bundledReleaseNotes.body,
    });
    const automaticBody = notes.presentation?.body;

    notes.dismiss();
    notes.openInstalledNotes();

    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.1.23",
      body: automaticBody,
    });
    expect(notes.presentation?.body).toBe(bundledReleaseNotes.body);
  });

  it("starts with the packaged version and resolves the runtime version once", async () => {
    const getRuntimeVersion = vi.fn().mockResolvedValue("0.2.0");
    const notes = controller(getRuntimeVersion);

    expect(notes.installedVersion).toBe("0.2.0");
    expect(notes.resolutionPending).toBe(true);
    notes.setUiReady(true);

    await Promise.all([
      notes.resolveRuntimeVersion(),
      notes.resolveRuntimeVersion(),
    ]);

    expect(getRuntimeVersion).toHaveBeenCalledTimes(1);
    expect(notes.installedVersion).toBe("0.2.0");
    expect(notes.resolutionPending).toBe(false);
  });

  it.each(["", "  ", " 0.2.0", null, undefined, 42, {}])(
    "keeps the packaged fallback for an invalid runtime version: %j",
    async (runtimeVersion) => {
      const notes = controller(() => Promise.resolve(runtimeVersion));
      notes.setUiReady(true);

      await notes.resolveRuntimeVersion();

      expect(notes.installedVersion).toBe("0.2.0");
      expect(notes.presentation).toBeNull();
    },
  );

  it("keeps bundled notes available offline after runtime lookup fails", async () => {
    const notes = controller(
      () => Promise.reject(new Error("native runtime unavailable")),
      null,
    );
    notes.setUiReady(true);

    await notes.resolveRuntimeVersion();
    notes.openInstalledNotes();

    expect(notes.installedVersion).toBe("0.2.0");
    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.2.0",
      body: bundled.body,
    });
  });

  it("uses a matching marker only as the automatic trigger", async () => {
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: "0.2.0",
      body: "<script>Untrusted updater body</script>",
    });
    const notes = controller(() => Promise.resolve("0.2.0"), storage);

    await notes.resolveRuntimeVersion();
    expect(notes.presentation).toBeNull();

    notes.setUiReady(true);

    expect(notes.presentation).toEqual({
      kind: "automatic",
      version: "0.2.0",
      body: bundled.body,
    });
    expect(notes.presentation?.body).not.toContain("Untrusted updater body");
  });

  it("ignores and preserves a stale marker while manual notes stay canonical", async () => {
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: "0.1.0",
      body: "Stale updater body",
    });
    const notes = controller(() => Promise.resolve("0.2.0"), storage);
    notes.setUiReady(true);

    await notes.resolveRuntimeVersion();
    expect(notes.presentation).toBeNull();

    notes.openInstalledNotes();
    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.2.0",
      body: bundled.body,
    });
    expect(readPendingReleaseNotes(storage)?.version).toBe("0.1.0");
  });

  it("reopens the exact same version and body after automatic dismissal", async () => {
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: "0.2.0",
      body: "Legacy body",
    });
    const notes = controller(() => Promise.resolve("0.2.0"), storage);
    notes.setUiReady(true);
    await notes.resolveRuntimeVersion();
    const automatic = notes.presentation;

    notes.dismiss();
    notes.openInstalledNotes();

    expect(notes.presentation).toEqual({
      ...automatic,
      kind: "manual",
    });
    expect(readPendingReleaseNotes(storage)).toBeNull();

    const relaunched = controller(() => Promise.resolve("0.2.0"), storage);
    relaunched.setUiReady(true);
    await relaunched.resolveRuntimeVersion();
    expect(relaunched.presentation).toBeNull();
  });

  it("dismisses only the exact marker captured for automatic presentation", async () => {
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: "0.2.0",
      body: "Original marker",
    });
    const notes = controller(() => Promise.resolve("0.2.0"), storage);
    notes.setUiReady(true);
    await notes.resolveRuntimeVersion();

    savePendingReleaseNotes(storage, {
      version: "0.2.0",
      body: "New marker written while the modal was open",
    });
    notes.dismiss();

    expect(readPendingReleaseNotes(storage)).toEqual({
      version: "0.2.0",
      body: "New marker written while the modal was open",
    });
    expect(notes.presentation).toBeNull();
  });

  it("does not remove a pending marker when a manual presentation closes", async () => {
    const storage = new MemoryStorage();
    savePendingReleaseNotes(storage, {
      version: "0.1.0",
      body: "Stale marker",
    });
    const notes = controller(() => Promise.resolve("0.2.0"), storage);
    notes.setUiReady(true);
    await notes.resolveRuntimeVersion();

    notes.openInstalledNotes();
    notes.dismiss();

    expect(readPendingReleaseNotes(storage)?.version).toBe("0.1.0");
  });

  it("shows the actual runtime version with localized unavailable copy on mismatch", async () => {
    const notes = controller(() => Promise.resolve("0.3.0"));
    notes.setUiReady(true);

    await notes.resolveRuntimeVersion();
    notes.openInstalledNotes();

    expect(notes.installedVersion).toBe("0.3.0");
    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.3.0",
      body: "Release notes are unavailable for this version.",
    });
    expect(notes.presentation?.body).not.toBe(bundled.body);
  });

  it("updates an already open packaged presentation if runtime resolution finds a mismatch", async () => {
    let resolve!: (version: string) => void;
    const runtimeVersion = new Promise<string>((done) => (resolve = done));
    const notes = controller(() => runtimeVersion);

    notes.openInstalledNotes();
    expect(notes.presentation?.body).toBe(bundled.body);

    const resolution = notes.resolveRuntimeVersion();
    resolve("0.3.0");
    await resolution;

    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.3.0",
      body: "Release notes are unavailable for this version.",
    });
  });

  it("opens the packaged notes without waiting for a runtime lookup that never settles", () => {
    const notes = controller(() => new Promise(() => {}), null);

    void notes.resolveRuntimeVersion();
    notes.openInstalledNotes();

    expect(notes.resolutionPending).toBe(true);
    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.2.0",
      body: bundled.body,
    });
  });

  it("refreshes localized unavailable copy without changing the actual version", async () => {
    let unavailable = "Release notes unavailable.";
    const notes = createReleaseNotesController({
      bundled,
      getRuntimeVersion: () => Promise.resolve("0.3.0"),
      getStorage: () => null,
      unavailableBody: () => unavailable,
    });
    notes.setUiReady(true);
    await notes.resolveRuntimeVersion();
    notes.openInstalledNotes();
    expect(notes.presentation?.body).toBe("Release notes unavailable.");

    unavailable = "Notas no disponibles.";
    notes.setUiReady(true);

    expect(notes.presentation).toEqual({
      kind: "manual",
      version: "0.3.0",
      body: "Notas no disponibles.",
    });
  });
});
