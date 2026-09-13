// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { m } from "$lib/paraglide/messages";
import { bundledReleaseNotes } from "$lib/update/bundledReleaseNotes";
import {
  type BackupAdapterStatus,
  BackupStore,
} from "$lib/state/backup.svelte";
import { type BackupUiSettings, uiLocale } from "$lib/state/uiLocale.svelte";
import BackupStatusCard, {
  type BackupSettingsFacade,
} from "./BackupStatusCard.svelte";

/**
 * Tasks 10.3/10.8: dismissible optional setup card, configured health
 * states with text (never color alone), preserved previous success time
 * while running, and live-region announcements.
 */

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await tick();
}

function fakeSettings(
  backup?: BackupUiSettings,
): BackupSettingsFacade & {
  updateBackup: ReturnType<typeof vi.fn>;
  flushPending(): Promise<void>;
} {
  return {
    backup,
    updateBackup: vi.fn<BackupSettingsFacade["updateBackup"]>(),
    flushPending: () => Promise.resolve(),
  };
}

function fakeStore(
  settings: BackupSettingsFacade & { flushPending(): Promise<void> },
): BackupStore {
  return new BackupStore({
    adapter: {
      status: () =>
        Promise.resolve(
          {
            configured: true,
            folderAvailable: true,
            requiresReauthorization: false,
            backupSetId: "aaaaaaaa-1111-4111-8111-111111111111",
            folderPath: "/synced/Tesina",
          } satisfies BackupAdapterStatus,
        ),
      writeArchive: () => Promise.resolve({ sha256: "x" }),
      discardPendingArchive: () => Promise.resolve(),
      confirmArchive: () => Promise.resolve(),
      readArchive: () => Promise.resolve(new Uint8Array()),
      listArchives: () => Promise.resolve([]),
      listArchiveNames: () => Promise.resolve([]),
      removeArchive: () => Promise.resolve(),
      ledgerEntries: () => Promise.resolve([]),
    },
    packageArchive: () =>
      Promise.resolve({ bytes: new Uint8Array(), contentDigest: "d" }),
    currentContentDigest: () => Promise.resolve("d"),
    validateArchiveBytes: () => Promise.resolve(),
    settings,
    runOperation: (_kind, fn) => fn(new AbortController().signal),
    subscribeActivity: () => () => {},
    now: () => new Date(2026, 7, 8, 10, 0, 0),
  });
}

const CONFIGURED: BackupAdapterStatus = {
  configured: true,
  folderAvailable: true,
  requiresReauthorization: false,
  folderPath: "/synced/Tesina",
  backupSetId: "aaaaaaaa-1111-4111-8111-111111111111",
};

const UNCONFIGURED: BackupAdapterStatus = {
  configured: false,
  folderAvailable: false,
  requiresReauthorization: false,
};

const REAUTHORIZATION_REQUIRED: BackupAdapterStatus = {
  configured: false,
  folderAvailable: false,
  requiresReauthorization: true,
};

let component: Record<string, unknown> | null = null;

function mountCard(props: {
  status: BackupAdapterStatus;
  settings: BackupSettingsFacade;
  store: BackupStore;
  onSetup?: () => void;
  onOpenSettings?: () => void;
}): void {
  component = mount(BackupStatusCard, {
    target: document.body,
    props: {
      statusSource: { status: () => Promise.resolve(props.status) },
      settings: props.settings,
      store: props.store,
      onSetup: props.onSetup ?? (() => {}),
      onOpenSettings: props.onOpenSettings ?? (() => {}),
    },
  }) as Record<string, unknown>;
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  );
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = "";
  uiLocale.current = "es";
});

describe("BackupStatusCard", () => {
  it("offers optional setup when unconfigured and persists dismissal", async () => {
    const settings = fakeSettings(undefined);
    const onSetup = vi.fn();
    mountCard({
      status: UNCONFIGURED,
      settings,
      store: fakeStore(settings),
      onSetup,
    });
    await settle();
    expect(document.body.textContent).toContain(m.bk_card_title());

    buttonByText(m.bk_card_setup())!.click();
    expect(onSetup).toHaveBeenCalledOnce();

    buttonByText(m.bk_card_dismiss())!.click();
    await settle();
    expect(settings.updateBackup).toHaveBeenCalledWith({
      setupCardDismissed: true,
    });
    expect(document.body.textContent).not.toContain(m.bk_card_title());
  });

  it("stays hidden once the dismissal preference is stored", async () => {
    const settings = fakeSettings({ setupCardDismissed: true });
    mountCard({ status: UNCONFIGURED, settings, store: fakeStore(settings) });
    await settle();
    expect(document.body.textContent).not.toContain(m.bk_card_title());
  });

  it("shows mandatory reauthorization guidance even when setup was dismissed", async () => {
    const settings = fakeSettings({ setupCardDismissed: true });
    const onSetup = vi.fn();
    mountCard({
      status: REAUTHORIZATION_REQUIRED,
      settings,
      store: fakeStore(settings),
      onSetup,
    });
    await settle();

    expect(document.body.textContent).toContain(m.bk_reauthorization_title());
    expect(document.body.textContent).toContain(
      m.bk_reauthorization_body({ version: bundledReleaseNotes.version }),
    );
    expect(buttonByText(m.bk_card_dismiss())).toBeUndefined();
    buttonByText(m.bk_card_setup())!.click();
    expect(onSetup).toHaveBeenCalledOnce();
  });

  it("shows healthy state with last success and next expected condition", async () => {
    const settings = fakeSettings({
      lastSuccessAt: "2026-08-07T10:00:00.000Z",
    });
    mountCard({ status: CONFIGURED, settings, store: fakeStore(settings) });
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain(m.bk_state_healthy());
    expect(text).toContain(m.bk_next_expected());
    // Formatted last-success time, not the raw ISO string.
    expect(text).toContain("2026");
    expect(text).not.toContain("2026-08-07T10:00:00.000Z");
  });

  it("a running backup preserves the previous success time", async () => {
    const settings = fakeSettings({
      lastSuccessAt: "2026-08-07T10:00:00.000Z",
    });
    const store = fakeStore(settings);
    mountCard({ status: CONFIGURED, settings, store });
    await settle();

    store.running = true;
    flushSync();
    const text = document.body.textContent ?? "";
    expect(text).toContain(m.bk_state_running());
    // Live region announces state changes.
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      m.bk_state_running(),
    );
    // The previous success time is still displayed.
    expect(text).toContain(m.bk_last_success({ time: "" }).split("{")[0]!);
    expect(text).toContain("2026");
  });

  it("warning state carries text plus retry and re-selection actions", async () => {
    const settings = fakeSettings({
      lastSuccessAt: "2026-08-06T10:00:00.000Z",
      lastErrorCode: "folder_unavailable",
    });
    const store = fakeStore(settings);
    const runManual = vi.spyOn(store, "runManual").mockResolvedValue({
      kind: "success",
      fileName: "x.tesina",
      retentionWarning: false,
    });
    const onSetup = vi.fn();
    mountCard({ status: CONFIGURED, settings, store, onSetup });
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain(m.bk_state_warning());
    expect(text).toContain(m.bk_err_folder_unavailable());

    buttonByText(m.bk_retry())!.click();
    expect(runManual).toHaveBeenCalledOnce();
    buttonByText(m.bk_choose_another())!.click();
    expect(onSetup).toHaveBeenCalledOnce();
  });

  it("retention warning is announced with manual-cleanup guidance", async () => {
    const settings = fakeSettings({
      lastSuccessAt: "2026-08-07T10:00:00.000Z",
    });
    const store = fakeStore(settings);
    store.retentionWarning = true;
    mountCard({ status: CONFIGURED, settings, store });
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain(m.bk_state_retention());
    expect(text).toContain(m.bk_retention_help());
  });

  it("prioritizes a native resource limit as manual-cleanup guidance", async () => {
    const settings = fakeSettings({
      lastSuccessAt: "2026-08-07T10:00:00.000Z",
      lastErrorCode: "resource_limit",
    });
    const store = fakeStore(settings);
    mountCard({ status: CONFIGURED, settings, store });
    await settle();

    expect(document.body.textContent).toContain(m.bk_state_retention());
    expect(document.body.textContent).toContain(m.bk_retention_help());
    expect(document.body.textContent).not.toContain(m.bk_state_warning());
  });

  it("localizes the card in both UI languages", async () => {
    const settings = fakeSettings(undefined);
    mountCard({ status: UNCONFIGURED, settings, store: fakeStore(settings) });
    await settle();
    expect(document.body.textContent).toContain("Respalda tu biblioteca");
    if (component) unmount(component);
    component = null;
    document.body.innerHTML = "";

    uiLocale.current = "en";
    const settingsEn = fakeSettings(undefined);
    mountCard({
      status: UNCONFIGURED,
      settings: settingsEn,
      store: fakeStore(settingsEn),
    });
    await settle();
    expect(document.body.textContent).toContain("Back up your library");
  });

  it("localizes reauthorization guidance in both UI languages", async () => {
    const settings = fakeSettings(undefined);
    mountCard({
      status: REAUTHORIZATION_REQUIRED,
      settings,
      store: fakeStore(settings),
    });
    await settle();
    expect(document.body.textContent).toContain(
      "seleccionar la carpeta otra vez",
    );
    if (component) unmount(component);
    component = null;
    document.body.innerHTML = "";

    uiLocale.current = "en";
    const settingsEn = fakeSettings(undefined);
    mountCard({
      status: REAUTHORIZATION_REQUIRED,
      settings: settingsEn,
      store: fakeStore(settingsEn),
    });
    await settle();
    expect(document.body.textContent?.toLowerCase()).toContain(
      "select the folder again",
    );
  });
});
