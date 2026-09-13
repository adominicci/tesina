import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPendingReleaseNotes,
  type ReleaseNotesStorage,
} from "$lib/update/releaseNotes";

const svelteRuntime = vi.hoisted(() => {
  Object.defineProperty(globalThis, "$state", {
    configurable: true,
    value: <T>(initial: T): T => initial,
  });
  return {};
});

import {
  AUTO_CHECK_INTERVAL_MS,
  type UpdaterDependencies,
  UpdaterStore,
} from "./updater.svelte.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class MemoryStorage implements ReleaseNotesStorage {
  #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe("UpdaterStore install lifecycle", () => {
  beforeEach(() => {
    void svelteRuntime;
  });

  it("waits for inference shutdown after persistence and before Windows installation", async () => {
    const events: string[] = [];
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          downloadAndInstall: async () => {},
          download: () => {
            events.push("download");
            return Promise.resolve();
          },
          install: () => {
            events.push("install");
            return Promise.resolve();
          },
        }),
      hostOs: () => Promise.resolve("windows"),
      storage: () => null,
      flushPending: () => {
        events.push("persist");
        return Promise.resolve();
      },
      prepareInferenceShutdown: () => {
        events.push("inference");
        return Promise.resolve();
      },
      relaunch: () => {
        events.push("relaunch");
        return Promise.resolve();
      },
    });
    await store.check();
    await store.install();
    expect(events).toEqual(["download", "persist", "inference", "install"]);
  });

  it("finalizes failed inference cleanup even when recovery rejects and keeps retries before install", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const cleanupError = new Error("cleanup failed");
    const recoveryError = new Error("RECOVERY_DIAGNOSTIC_CANARY");
    const prepareInferenceShutdown = vi.fn<() => Promise<void>>()
      .mockRejectedValue(cleanupError);
    const resumeAfterFailedShutdown = vi.fn<() => Promise<void>>()
      .mockRejectedValue(recoveryError);
    const install = vi.fn<() => Promise<void>>().mockResolvedValue();
    const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue();
    const downloadAndInstall = vi.fn<() => Promise<void>>().mockResolvedValue();
    const storage = new MemoryStorage();
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          downloadAndInstall,
          download: () => Promise.resolve(),
          install,
        }),
      hostOs: () => Promise.resolve("windows"),
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      prepareInferenceShutdown,
      resumeAfterFailedShutdown,
      relaunch,
    });
    try {
      await store.check();
      for (let attempt = 1; attempt <= 2; attempt++) {
        await expect(store.install()).resolves.toBeUndefined();
        expect(store.status).toBe("error");
        expect(prepareInferenceShutdown).toHaveBeenCalledTimes(attempt);
        expect(resumeAfterFailedShutdown).toHaveBeenCalledTimes(attempt);
        expect(install).not.toHaveBeenCalled();
        expect(downloadAndInstall).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();
        expect(readPendingReleaseNotes(storage)).toBeNull();
        expect(consoleError).toHaveBeenLastCalledWith(
          "No se pudo instalar la actualización:",
          cleanupError,
        );
      }
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("persists manifest notes after installation and before relaunch", async () => {
    const storage = new MemoryStorage();
    let installed = false;
    let flushed = false;
    let relaunched = false;
    const dependencies: UpdaterDependencies = {
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Citation fixes\nExport improvements",
          downloadAndInstall: () => {
            expect(readPendingReleaseNotes(storage)).toBeNull();
            installed = true;
            return Promise.resolve();
          },
        }),
      storage: () => storage,
      flushPending: () => {
        expect(installed).toBe(true);
        expect(readPendingReleaseNotes(storage)).toBeNull();
        flushed = true;
        return Promise.resolve();
      },
      relaunch: () => {
        expect(installed).toBe(true);
        expect(flushed).toBe(true);
        expect(readPendingReleaseNotes(storage)).toEqual({
          version: "0.2.0",
          body: "Citation fixes\nExport improvements",
        });
        relaunched = true;
        return Promise.resolve();
      },
    };
    const store = new UpdaterStore(dependencies);

    await store.check();

    expect(store.version).toBe("0.2.0");
    expect(store.body).toBe("Citation fixes\nExport improvements");
    expect(store.status).toBe("available");

    await store.install();

    expect(relaunched).toBe(true);
    expect(store.progress).toBe(100);
  });

  it("does not persist or relaunch on failure and can retry the offered update", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const storage = new MemoryStorage();
    let relaunched = false;
    let installAttempts = 0;
    const dependencies: UpdaterDependencies = {
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Should not appear",
          downloadAndInstall: () => {
            installAttempts += 1;
            return installAttempts === 1
              ? Promise.reject(new Error("signature rejected"))
              : Promise.resolve();
          },
        }),
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      relaunch: () => {
        relaunched = true;
        return Promise.resolve();
      },
    };
    const store = new UpdaterStore(dependencies);

    try {
      await store.check();
      await store.install();

      expect(store.status).toBe("error");
      expect(readPendingReleaseNotes(storage)).toBeNull();
      expect(relaunched).toBe(false);

      await store.install();

      expect(installAttempts).toBe(2);
      expect(readPendingReleaseNotes(storage)).toEqual({
        version: "0.2.0",
        body: "Should not appear",
      });
      expect(relaunched).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("installs and persists the offered update when a stale check resolves during installation", async () => {
    const storage = new MemoryStorage();
    const installA = deferred<void>();
    const checkB = deferred<
      {
        version: string;
        body: string;
        downloadAndInstall: () => Promise<void>;
      } | null
    >();
    let checkCount = 0;
    const dependencies: UpdaterDependencies = {
      check: () => {
        checkCount += 1;
        return checkCount === 1
          ? Promise.resolve({
            version: "0.2.0",
            body: "Installed A",
            downloadAndInstall: () => installA.promise,
          })
          : checkB.promise;
      },
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      relaunch: () => Promise.resolve(),
    };
    const store = new UpdaterStore(dependencies);
    await store.check();

    const staleCheck = store.check();
    const installing = store.install();
    checkB.resolve({
      version: "0.3.0",
      body: "Offered B",
      downloadAndInstall: () => Promise.resolve(),
    });
    await staleCheck;

    expect(store.status).toBe("downloading");
    expect(store.version).toBe("0.2.0");
    expect(store.body).toBe("Installed A");

    installA.resolve();
    await installing;

    expect(readPendingReleaseNotes(storage)).toEqual({
      version: "0.2.0",
      body: "Installed A",
    });
  });

  it("does not install a consumed update twice while its first install is pending", async () => {
    const storage = new MemoryStorage();
    const installation = deferred<void>();
    let installCount = 0;
    const dependencies: UpdaterDependencies = {
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "One install",
          downloadAndInstall: () => {
            installCount += 1;
            return installation.promise;
          },
        }),
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      relaunch: () => Promise.resolve(),
    };
    const store = new UpdaterStore(dependencies);
    await store.check();

    const first = store.install();
    const duplicate = store.install();

    expect(installCount).toBe(1);

    installation.resolve();
    await Promise.all([first, duplicate]);
  });

  it("retains installed notes if relaunch is rejected", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const storage = new MemoryStorage();
    const resumeAfterFailedShutdown = vi.fn<() => Promise<void>>()
      .mockResolvedValue();
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Installed before relaunch",
          downloadAndInstall: () => Promise.resolve(),
        }),
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      relaunch: () => Promise.reject(new Error("relaunch unavailable")),
      resumeAfterFailedShutdown,
    });

    try {
      await store.check();
      await store.install();

      expect(store.status).toBe("error");
      expect(readPendingReleaseNotes(storage)).toEqual({
        version: "0.2.0",
        body: "Installed before relaunch",
      });
      expect(resumeAfterFailedShutdown).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retries persistence after installation without downloading twice", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const storage = new MemoryStorage();
    let installAttempts = 0;
    let flushAttempts = 0;
    let relaunches = 0;
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Retry persistence",
          downloadAndInstall: () => {
            installAttempts += 1;
            return Promise.resolve();
          },
        }),
      storage: () => storage,
      flushPending: () => {
        flushAttempts += 1;
        return flushAttempts === 1
          ? Promise.reject(new Error("disk unavailable"))
          : Promise.resolve();
      },
      relaunch: () => {
        relaunches += 1;
        return Promise.resolve();
      },
    });

    try {
      await store.check();
      await store.install();

      expect(store.status).toBe("error");
      expect(installAttempts).toBe(1);
      expect(readPendingReleaseNotes(storage)).toBeNull();
      expect(relaunches).toBe(0);

      await store.install();

      expect(installAttempts).toBe(1);
      expect(flushAttempts).toBe(2);
      expect(readPendingReleaseNotes(storage)).toEqual({
        version: "0.2.0",
        body: "Retry persistence",
      });
      expect(relaunches).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retries relaunch after installation without downloading twice", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const storage = new MemoryStorage();
    let installAttempts = 0;
    let relaunchAttempts = 0;
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Retry relaunch",
          downloadAndInstall: () => {
            installAttempts += 1;
            return Promise.resolve();
          },
        }),
      storage: () => storage,
      flushPending: () => Promise.resolve(),
      relaunch: () => {
        relaunchAttempts += 1;
        return relaunchAttempts === 1
          ? Promise.reject(new Error("relaunch unavailable"))
          : Promise.resolve();
      },
    });

    try {
      await store.check();
      await store.install();

      expect(store.status).toBe("error");
      expect(installAttempts).toBe(1);
      expect(relaunchAttempts).toBe(1);

      await store.install();

      expect(installAttempts).toBe(1);
      expect(relaunchAttempts).toBe(2);
      expect(store.status).toBe("idle");

      await store.install();
      expect(installAttempts).toBe(1);
      expect(relaunchAttempts).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not replace an installed update while its relaunch is pending", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    let checkCount = 0;
    let firstInstallAttempts = 0;
    let secondInstallAttempts = 0;
    let relaunchAttempts = 0;
    const store = new UpdaterStore({
      check: () => {
        checkCount += 1;
        return Promise.resolve(
          checkCount === 1
            ? {
              version: "0.2.0",
              body: "Installed update",
              downloadAndInstall: () => {
                firstInstallAttempts += 1;
                return Promise.resolve();
              },
            }
            : {
              version: "0.3.0",
              body: "Later update",
              downloadAndInstall: () => {
                secondInstallAttempts += 1;
                return Promise.resolve();
              },
            },
        );
      },
      storage: () => null,
      flushPending: () => Promise.resolve(),
      relaunch: () => {
        relaunchAttempts += 1;
        return relaunchAttempts === 1
          ? Promise.reject(new Error("relaunch unavailable"))
          : Promise.resolve();
      },
    });

    try {
      await store.check();
      await store.install();
      await store.check();

      expect(checkCount).toBe(1);
      expect(store.version).toBe("0.2.0");
      expect(store.body).toBe("Installed update");

      await store.install();

      expect(firstInstallAttempts).toBe(1);
      expect(secondInstallAttempts).toBe(0);
      expect(relaunchAttempts).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still relaunches after best-effort storage rejects the marker write", async () => {
    let relaunched = false;
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Storage unavailable",
          downloadAndInstall: () => Promise.resolve(),
        }),
      storage: () => ({
        getItem: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new Error("quota unavailable");
        },
      }),
      flushPending: () => Promise.resolve(),
      relaunch: () => {
        relaunched = true;
        return Promise.resolve();
      },
    });

    await store.check();
    await store.install();

    expect(relaunched).toBe(true);
    expect(store.progress).toBe(100);
  });

  it("waits for editor and library persistence before marking and relaunching", async () => {
    const storage = new MemoryStorage();
    const flushing = deferred<void>();
    let relaunched = false;
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Persistence barrier",
          downloadAndInstall: () => Promise.resolve(),
        }),
      storage: () => storage,
      flushPending: () => flushing.promise,
      relaunch: () => {
        relaunched = true;
        return Promise.resolve();
      },
    });
    await store.check();

    const installing = store.install();
    await Promise.resolve();
    await Promise.resolve();

    expect(readPendingReleaseNotes(storage)).toBeNull();
    expect(relaunched).toBe(false);
    flushing.resolve();
    await installing;
    expect(readPendingReleaseNotes(storage)).toEqual({
      version: "0.2.0",
      body: "Persistence barrier",
    });
    expect(relaunched).toBe(true);
  });

  it("does not mark or relaunch when persistence flushing rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    const storage = new MemoryStorage();
    let relaunched = false;
    const store = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Must not be marked",
          downloadAndInstall: () => Promise.resolve(),
        }),
      storage: () => storage,
      flushPending: () => Promise.reject(new Error("disk full")),
      relaunch: () => {
        relaunched = true;
        return Promise.resolve();
      },
    });

    try {
      await store.check();
      await store.install();

      expect(store.status).toBe("error");
      expect(readPendingReleaseNotes(storage)).toBeNull();
      expect(relaunched).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("UpdaterStore periodic checks", () => {
  it("re-checks on the interval until stopped", () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      const store = new UpdaterStore({
        check: () => {
          checks += 1;
          return Promise.resolve(null);
        },
        flushPending: () => Promise.resolve(),
        relaunch: () => Promise.resolve(),
        storage: () => null,
      });

      const stop = store.startPeriodicChecks(1000);
      expect(checks).toBe(0);

      vi.advanceTimersByTime(3500);
      expect(checks).toBe(3);

      stop();
      vi.advanceTimersByTime(5000);
      expect(checks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls every four minutes by default, matching the T3 Code cadence", () => {
    expect(AUTO_CHECK_INTERVAL_MS).toBe(4 * 60 * 1000);
  });
});

describe("UpdaterStore Windows install ordering", () => {
  it("flushes and stores notes after download but before the installer runs", async () => {
    const storage = new MemoryStorage();
    const events: string[] = [];
    const store = new UpdaterStore({
      hostOs: () => Promise.resolve("windows"),
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Windows notes",
          download: () => {
            events.push("download");
            return Promise.resolve();
          },
          install: () => {
            expect(readPendingReleaseNotes(storage)).toEqual({
              version: "0.2.0",
              body: "Windows notes",
            });
            events.push("install");
            return Promise.resolve();
          },
          downloadAndInstall: () => {
            events.push("downloadAndInstall");
            return Promise.resolve();
          },
        }),
      flushPending: () => {
        events.push("flush");
        return Promise.resolve();
      },
      relaunch: () => {
        events.push("relaunch");
        return Promise.resolve();
      },
      storage: () => storage,
    });

    await store.check();
    await store.install();

    expect(events).toEqual(["download", "flush", "install"]);
    expect(store.status).toBe("idle");
  });
});
