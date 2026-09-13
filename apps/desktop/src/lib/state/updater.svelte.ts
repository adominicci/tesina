import { check as tauriCheck, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import {
  type ReleaseNotesStorage,
  savePendingReleaseNotes,
} from "$lib/update/releaseNotes";
import { persistence } from "$lib/persist/coordinator";
import { operations } from "$lib/persist/operationCoordinator";
import {
  prepareLocalInferenceShutdown,
  resumeLocalInference,
} from "$lib/local-ai/lifecycle";

export interface UpdaterUpdate {
  version: string;
  body?: string;
  downloadAndInstall: Update["downloadAndInstall"];
  download?: Update["download"];
  install?: Update["install"];
}

export interface UpdaterDependencies {
  check(): Promise<UpdaterUpdate | null>;
  flushPending(): Promise<void>;
  prepareInferenceShutdown?(): Promise<void>;
  relaunch(): Promise<void>;
  resumeAfterFailedShutdown?(): Promise<void>;
  storage(): ReleaseNotesStorage | null;
  /** Host OS name ("windows", "macos", …); picks the install ordering. */
  hostOs?(): Promise<string>;
}

const defaultDependencies: UpdaterDependencies = {
  check: tauriCheck,
  // Updater relaunch is a shutdown: flush, then wait for active
  // export/backup/import operations to reach their safe points (§13).
  flushPending: async () => {
    await persistence.flushPending();
    await operations.awaitSafeShutdown();
    await persistence.flushPending();
  },
  relaunch,
  prepareInferenceShutdown: prepareLocalInferenceShutdown,
  resumeAfterFailedShutdown: async () => {
    await operations.resumeAfterFailedShutdown();
    await resumeLocalInference();
  },
  storage: () => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  },
  hostOs: () => invoke<string>("host_os").catch(() => ""),
};

/**
 * In-app auto-update (Tauri updater plugin). On launch the app checks the
 * GitHub Releases updater manifest; if a newer *published* version exists, the
 * shell shows a banner and the user updates on one click. The essays live in
 * $APPDATA and are untouched by an in-place app update.
 *
 * Follows the app's store convention: one class holding `$state` fields, a
 * single exported singleton. Both `check` and `install` swallow their errors —
 * before the first published release the endpoint 404s and the plugin throws,
 * and outside the Tauri runtime the call throws too; either way the store must
 * stay `idle` and never surface an unhandled rejection.
 */
type UpdaterStatus = "idle" | "available" | "downloading" | "error";

/** Background re-check cadence; matches T3 Code's desktop poll interval. */
export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 1000;

export class UpdaterStore {
  status = $state<UpdaterStatus>("idle");
  /** Version offered by the manifest, shown in the banner. */
  version = $state<string | undefined>(undefined);
  /** Plain-text release notes offered by the signed updater manifest. */
  body = $state<string | undefined>(undefined);
  /** Download progress 0–100 (only meaningful while `downloading`). */
  progress = $state(0);

  #update: UpdaterUpdate | null = null;
  #total = 0;
  #downloaded = 0;
  #installEpoch = 0;
  #installedPendingRelaunch = false;
  #dependencies: UpdaterDependencies;

  constructor(dependencies: UpdaterDependencies = defaultDependencies) {
    this.#dependencies = dependencies;
  }

  /** Check once, typically at boot. Never throws. */
  async check(): Promise<void> {
    if (this.status === "downloading" || this.#installedPendingRelaunch) return;
    const installEpoch = this.#installEpoch;
    try {
      const update = await this.#dependencies.check();
      if (installEpoch !== this.#installEpoch) return;
      if (update) {
        this.#update = update;
        this.version = update.version;
        this.body = update.body;
        this.status = "available";
      }
    } catch (err) {
      // No published release yet (404), offline, or not in the Tauri runtime.
      console.error("No se pudo comprobar actualizaciones:", err);
    }
  }

  /**
   * Re-check on a timer so an update published while the app stays open still
   * surfaces. `check()` already guards active downloads and pending relaunches.
   * Returns a stop function for component teardown.
   */
  startPeriodicChecks(intervalMs: number = AUTO_CHECK_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.check();
    }, intervalMs);
    return () => clearInterval(timer);
  }

  /** Download + install the pending update, then relaunch. Never throws. */
  async install(): Promise<void> {
    if (!this.#update || this.status === "downloading") return;
    const update = this.#update;
    this.#installEpoch += 1;
    this.status = "downloading";
    try {
      const onProgress: Parameters<Update["downloadAndInstall"]>[0] = (e) => {
        switch (e.event) {
          case "Started":
            this.#total = e.data.contentLength ?? 0;
            break;
          case "Progress":
            this.#downloaded += e.data.chunkLength;
            if (this.#total > 0) {
              this.progress = Math.min(
                100,
                Math.round((this.#downloaded / this.#total) * 100),
              );
            }
            break;
          case "Finished":
            this.progress = 100;
            break;
        }
      };

      // On Windows the NSIS installer terminates the process inside
      // `install()`, so nothing after it can be relied on: pending work and
      // the release-notes marker must be persisted between download and
      // install, and the installer owns the restart. The host check runs only
      // when the update supports the split flow, so the plain path keeps its
      // synchronous start.
      if (update.download && update.install) {
        const hostOs = await this.#dependencies.hostOs?.().catch(() => "") ??
          "";
        if (hostOs === "windows") {
          this.progress = 0;
          this.#total = 0;
          this.#downloaded = 0;
          await update.download(onProgress);
          await this.#dependencies.flushPending();
          await this.#dependencies.prepareInferenceShutdown?.();
          this.#savePendingNotes(update);
          await update.install();
          this.progress = 100;
          this.#update = null;
          this.status = "idle";
          return;
        }
      }

      if (!this.#installedPendingRelaunch) {
        this.progress = 0;
        this.#total = 0;
        this.#downloaded = 0;
        await update.downloadAndInstall(onProgress);
        this.#installedPendingRelaunch = true;
        this.progress = 100;
      }
      await this.#dependencies.flushPending();
      await this.#dependencies.prepareInferenceShutdown?.();
      this.#savePendingNotes(update);
      await this.#dependencies.relaunch();
      this.#update = null;
      this.#installedPendingRelaunch = false;
      this.status = "idle";
    } catch (err) {
      try {
        await this.#dependencies.resumeAfterFailedShutdown?.();
      } catch {
        // Recovery can remain blocked by failed cleanup; retain the original error.
      }
      console.error("No se pudo instalar la actualización:", err);
      this.status = "error";
    }
  }

  #savePendingNotes(update: UpdaterUpdate): void {
    try {
      const storage = this.#dependencies.storage();
      if (storage) {
        savePendingReleaseNotes(storage, {
          version: update.version,
          body: update.body ?? "",
        });
      }
    } catch (err) {
      // Notes are best-effort; storage failure cannot strand an installed
      // update in the old process.
      console.error("No se pudieron guardar las notas de versión:", err);
    }
  }
}

export const updater = new UpdaterStore();
