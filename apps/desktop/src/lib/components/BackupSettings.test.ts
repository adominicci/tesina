// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { m } from "$lib/paraglide/messages";
import { bundledReleaseNotes } from "$lib/update/bundledReleaseNotes";
import { uiLocale } from "$lib/state/uiLocale.svelte";
import {
  type BackupAdapter,
  type BackupAdapterStatus,
  type BackupRunOutcome,
  BackupStore,
} from "$lib/state/backup.svelte";
import type { BackupUiSettings } from "$lib/state/uiLocale.svelte";
import type {
  ImportApplyResult,
  ImportPreviewResult,
} from "$lib/persist/importFlow";
import type { BackupSettingsFacade } from "./BackupStatusCard.svelte";
import BackupSettings from "./BackupSettings.svelte";

/**
 * Tasks 10.4/10.5/10.8: Back up now single-flight UI, preserved previous
 * success while running, Turn off keeps files, Restore lists retained
 * archives and routes through the shared Merge preview with the
 * restore-consequences disclosure.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await tick();
}

const ARCHIVE_NAME = "Tesina Library - a1b2c3d4 - 2026-08-07T19-42-00Z.tesina";

function fixturePreview(): ImportPreviewResult {
  return {
    preview: {
      essays: { new: 1, identical: 0, conflicting: 0 },
      references: { new: 0, identical: 0, conflicting: 0 },
      collections: { new: 0, identical: 0, conflicting: 0 },
      assets: { reused: 0, added: 0 },
    },
  } as ImportPreviewResult;
}

class Harness {
  configured = true;
  requiresReauthorization = false;
  archives = [{ fileName: ARCHIVE_NAME, byteLength: 1024 }];
  settings: BackupSettingsFacade & {
    updateBackup: ReturnType<typeof vi.fn>;
    flushPending(): Promise<void>;
  };
  adapter: BackupAdapter;
  store: BackupStore;
  turnOff = vi.fn(() => {
    this.configured = false;
    return Promise.resolve();
  });
  openFolder = vi.fn(() => Promise.resolve());
  restorePreview = vi.fn((_fileName: string) =>
    Promise.resolve(fixturePreview())
  );
  restoreApply = vi.fn((_confirmed: ImportPreviewResult) =>
    Promise.resolve(
      {
        kind: "applied",
        transactionId: "t",
        preview: fixturePreview().preview,
      } satisfies ImportApplyResult,
    )
  );
  onRunWizard = vi.fn();
  onRestored = vi.fn();
  onBackupChanged = vi.fn();
  onClose = vi.fn();

  constructor(backup?: BackupUiSettings) {
    this.settings = {
      backup,
      updateBackup: vi.fn<BackupSettingsFacade["updateBackup"]>(),
      flushPending: () => Promise.resolve(),
    };
    this.adapter = {
      status: () =>
        Promise.resolve(
          {
            configured: this.configured,
            folderAvailable: this.configured,
            requiresReauthorization: this.requiresReauthorization,
            ...(this.configured
              ? {
                folderPath: "/synced/Tesina",
                backupSetId: "aaaaaaaa-1111-4111-8111-111111111111",
              }
              : {}),
          } satisfies BackupAdapterStatus,
        ),
      writeArchive: () => Promise.resolve({ sha256: "x" }),
      discardPendingArchive: () => Promise.resolve(),
      confirmArchive: () => Promise.resolve(),
      readArchive: () => Promise.resolve(new Uint8Array()),
      listArchives: () => Promise.resolve([...this.archives]),
      listArchiveNames: () =>
        Promise.resolve(this.archives.map((archive) => archive.fileName)),
      removeArchive: () => Promise.resolve(),
      ledgerEntries: () => Promise.resolve([]),
    };
    this.store = new BackupStore({
      adapter: this.adapter,
      packageArchive: () =>
        Promise.resolve({ bytes: new Uint8Array(), contentDigest: "d" }),
      currentContentDigest: () => Promise.resolve("d"),
      validateArchiveBytes: () => Promise.resolve(),
      settings: this.settings,
      runOperation: (_kind, fn) => fn(new AbortController().signal),
      subscribeActivity: () => () => {},
      now: () => new Date(2026, 7, 8, 10, 0, 0),
    });
  }
}

let component: Record<string, unknown> | null = null;

function mountSettings(h: Harness): void {
  component = mount(BackupSettings, {
    target: document.body,
    props: {
      adapter: h.adapter,
      store: h.store,
      settings: h.settings,
      restorePreview: h.restorePreview,
      restoreApply: h.restoreApply,
      turnOff: h.turnOff,
      openFolder: h.openFolder,
      onRunWizard: h.onRunWizard,
      onRestored: h.onRestored,
      onBackupChanged: h.onBackupChanged,
      onClose: h.onClose,
    },
  }) as Record<string, unknown>;
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  );
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = "";
  uiLocale.current = "es";
});

describe("BackupSettings", () => {
  it("shows location, last success, and next expected condition", async () => {
    const h = new Harness({ lastSuccessAt: "2026-08-07T10:00:00.000Z" });
    mountSettings(h);
    await settle();
    const text = bodyText();
    expect(text).toContain("/synced/Tesina/Tesina Backups");
    expect(text).toContain(m.bk_next_expected());
    expect(text).toContain("2026");
    expect(text).toContain(m.bk_change_disclosure());
  });

  it("Back up now is disabled while running and preserves the success time", async () => {
    const h = new Harness({ lastSuccessAt: "2026-08-07T10:00:00.000Z" });
    const gate = deferred<BackupRunOutcome>();
    vi.spyOn(h.store, "runManual").mockImplementation(() => {
      h.store.running = true;
      return gate.promise;
    });
    mountSettings(h);
    await settle();

    const backupNow = buttonByText(m.bk_backup_now())!;
    expect(backupNow.disabled).toBe(false);
    backupNow.click();
    await settle();
    expect(h.store.runManual).toHaveBeenCalledOnce();
    expect(buttonByText(m.bk_backup_now())!.disabled).toBe(true);
    // Running is announced while the previous success time stays visible.
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      m.bk_state_running(),
    );
    expect(bodyText()).toContain("2026");

    h.store.running = false;
    gate.resolve({
      kind: "success",
      fileName: ARCHIVE_NAME,
      retentionWarning: false,
    });
    await settle();
    flushSync();
    expect(buttonByText(m.bk_backup_now())!.disabled).toBe(false);
    expect(bodyText()).toContain(m.bk_run_success());
  });

  it("a failed run surfaces a localized alert and a Retry action", async () => {
    const h = new Harness({
      lastSuccessAt: "2026-08-06T10:00:00.000Z",
      lastErrorCode: "folder_unavailable",
    });
    vi.spyOn(h.store, "runManual").mockResolvedValue({
      kind: "failed",
      errorCode: "folder_unavailable",
    });
    mountSettings(h);
    await settle();
    expect(bodyText()).toContain(m.bk_state_warning());

    buttonByText(m.bk_retry())!.click();
    await settle();
    expect(h.store.runManual).toHaveBeenCalledOnce();
    const alert = [...document.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? "")
      .join(" ");
    expect(alert).toContain(m.bk_err_folder_unavailable());
  });

  it("prioritizes resource limits and accumulation as retention guidance", async () => {
    const h = new Harness({
      lastSuccessAt: "2026-08-06T10:00:00.000Z",
      lastErrorCode: "resource_limit",
    });
    h.store.accumulationWarning = true;
    mountSettings(h);
    await settle();

    expect(bodyText()).toContain(m.bk_state_retention());
    expect(bodyText()).toContain(m.bk_retention_help());
    expect(bodyText()).not.toContain(m.bk_state_warning());
  });

  it("Turn off confirms, revokes, and explains files remain", async () => {
    const h = new Harness({ lastSuccessAt: "2026-08-07T10:00:00.000Z" });
    mountSettings(h);
    await settle();

    buttonByText(m.bk_turn_off())!.click();
    await settle();
    expect(h.turnOff).not.toHaveBeenCalled();
    expect(bodyText()).toContain(m.bk_turn_off_body());

    buttonByText(m.bk_turn_off_confirm())!.click();
    await settle();
    expect(h.turnOff).toHaveBeenCalledOnce();
    expect(h.onBackupChanged).toHaveBeenCalledOnce();
    const text = bodyText();
    expect(text).toContain(m.bk_turn_off_done());
    expect(text).toContain(m.bk_not_configured());
    // Re-enable requires a new folder + test backup, via the wizard.
    expect(text).toContain(m.bk_reenable_note());
    buttonByText(m.bk_reenable())!.click();
    expect(h.onRunWizard).toHaveBeenCalledOnce();
  });

  it("Change folder runs the wizard again", async () => {
    const h = new Harness();
    mountSettings(h);
    await settle();
    buttonByText(m.bk_change_folder())!.click();
    expect(h.onRunWizard).toHaveBeenCalledOnce();
  });

  it("Open backup folder delegates to the native reveal", async () => {
    const h = new Harness();
    mountSettings(h);
    await settle();
    buttonByText(m.bk_open_folder())!.click();
    await settle();
    expect(h.openFolder).toHaveBeenCalledOnce();
  });

  it("Restore lists archives, explains consequences, then opens Merge", async () => {
    const h = new Harness();
    mountSettings(h);
    await settle();

    buttonByText(m.bk_restore())!.click();
    await settle();
    // Consequences are explained before the Merge preview opens.
    expect(bodyText()).toContain(m.restore_consequences());
    expect(bodyText()).toContain(ARCHIVE_NAME);
    expect(h.restorePreview).not.toHaveBeenCalled();

    buttonByText(ARCHIVE_NAME)!.click();
    await settle();
    expect(h.restorePreview).toHaveBeenCalledWith(ARCHIVE_NAME);
    // The shared Merge preview (restore mode) is open with its counts.
    expect(bodyText()).toContain(m.imp_essays_new({ count: 1 }));
    expect(bodyText()).toContain(m.imp_confirm());

    buttonByText(m.imp_confirm())!.click();
    await settle();
    expect(h.restoreApply).toHaveBeenCalledOnce();
    expect(h.onRestored).toHaveBeenCalledOnce();
  });

  it("an empty backup folder announces there is nothing to restore", async () => {
    const h = new Harness();
    h.archives = [];
    mountSettings(h);
    await settle();
    buttonByText(m.bk_restore())!.click();
    await settle();
    expect(bodyText()).toContain(m.bk_restore_empty());
  });

  it("toggles the home setup-card preference", async () => {
    const h = new Harness();
    mountSettings(h);
    await settle();
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    await settle();
    expect(h.settings.updateBackup).toHaveBeenCalledWith({
      setupCardDismissed: true,
    });
  });

  it("uses neutral setup copy for a never-configured user", async () => {
    const h = new Harness();
    h.configured = false;
    uiLocale.current = "en";
    mountSettings(h);
    await settle();

    expect(bodyText()).toContain(m.bk_not_configured());
    expect(buttonByText("Set up backups")?.textContent?.trim()).toBe(
      "Set up backups",
    );
    expect(bodyText()).toContain(
      "Choose a folder and complete a test backup to finish setup.",
    );
    expect(bodyText()).not.toContain("again");
    expect(bodyText()).not.toContain("Turning backups back on");

    buttonByText("Set up backups")!.click();
    expect(h.onRunWizard).toHaveBeenCalledOnce();
  });

  it("explains one-time reauthorization and preserves old files", async () => {
    const h = new Harness();
    h.configured = false;
    h.requiresReauthorization = true;
    mountSettings(h);
    await settle();

    expect(bodyText()).toContain(m.bk_reauthorization_title());
    expect(bodyText()).toContain(
      m.bk_reauthorization_body({ version: bundledReleaseNotes.version }),
    );
    buttonByText(m.bk_reenable())!.click();
    expect(h.onRunWizard).toHaveBeenCalledOnce();
  });
});
