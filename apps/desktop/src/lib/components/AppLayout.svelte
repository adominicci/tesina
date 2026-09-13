<script lang="ts">
  // Inter's @font-face is embedded (base64) in the static document head
  // (app.html), NOT imported here — a Vite-processed @font-face kept getting
  // dropped in dev (WKWebView HMR + dev-server url() 404s). See AGENTS.md.
  import "$lib/styles/tokens.css";
  // Buttons, fields, Select and the status panel, for every surface that
  // carries `ui-controls` (a <Modal> already does). See the file header.
  import "$lib/styles/controls.css";
  // v2 additions — badge, chip, quiet button, empty state, modal widths.
  // Global like `.btn`, so they need no `ui-controls` host. Must load after
  // controls.css. See docs/design/DESIGN.md.
  import "$lib/styles/controls-v2.css";
  import { onMount, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import ReleaseNotesModal from "$lib/components/ReleaseNotesModal.svelte";
  import { uiLocale } from "$lib/state/uiLocale.svelte";
  import type { ReleaseNotesStorage } from "$lib/update/releaseNotes";
  import { bundledReleaseNotes } from "$lib/update/bundledReleaseNotes";
  import {
    createReleaseNotesController,
    provideReleaseNotesController,
  } from "$lib/update/releaseNotesController.svelte";
  import { m } from "$lib/paraglide/messages";
  import { library } from "$lib/state/library.svelte";
  import { persistence } from "$lib/persist/coordinator";
  import { operations } from "$lib/persist/operationCoordinator";
  import { createCloseRequestHandler } from "$lib/persist/windowClose";
  import { shutdown } from "$lib/state/shutdown.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { exit } from "@tauri-apps/plugin-process";
  import { exitAfterInferenceShutdown, resumeLocalInference } from "$lib/local-ai/lifecycle";
  import Modal from "$lib/components/Modal.svelte";

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  /**
   * The quit confirmations are ordinary modals rather than native dialogs, so
   * they match every other decision in the app. Each one is a promise the
   * shutdown path awaits, resolved by whichever button is pressed.
   */
  interface QuitPrompt {
    kind: "quit" | "unsaved";
    resolve: (confirmed: boolean) => void;
  }

  let quitPrompt = $state<QuitPrompt | null>(null);

  function askQuit(kind: QuitPrompt["kind"]): Promise<boolean> {
    return new Promise((resolve) => {
      quitPrompt = { kind, resolve };
    });
  }

  function answerQuit(confirmed: boolean): void {
    const pending = quitPrompt;
    quitPrompt = null;
    pending?.resolve(confirmed);
  }

  function browserStorage(): ReleaseNotesStorage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  const releaseNotes = provideReleaseNotesController(
    createReleaseNotesController({
      bundled: bundledReleaseNotes,
      getRuntimeVersion: getVersion,
      getStorage: browserStorage,
      unavailableBody: () =>
        m.release_notes_unavailable(undefined, {
          locale: uiLocale.current,
        }),
    }),
  );

  onMount(() => {
    // Version resolution is optional and must never delay startup. The
    // controller retains the statically bundled package version on failure.
    void releaseNotes.resolveRuntimeVersion();
  });

  onMount(() => {
    const libraryPersistence = persistence.register(() =>
      library.flushPending()
    );
    const settingsPersistence = persistence.register(() =>
      uiLocale.flushPending()
    );
    library.setPersistenceDirtyNotifier(libraryPersistence.markDirty);
    uiLocale.setPersistenceDirtyNotifier(settingsPersistence.markDirty);
    let disposed = false;
    let unlisten: (() => void) | undefined;

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const appWindow = getCurrentWindow();
      const onError = (error: unknown) => {
        console.error("Could not shut the application down cleanly:", error);
      };

      shutdown.configure({
        // Flush persistence first, then wait for active export/backup/import
        // operations to reach their safe points (cancel-and-clean or a
        // persisted recoverable journal) — design §13, task 6.7.
        flushPending: async () => {
          await persistence.flushPending();
          await operations.awaitSafeShutdown();
          await persistence.flushPending();
        },
        // The whole process ends, not just this window: on Windows and Linux
        // a destroyed main window would leave the app running with nothing on
        // screen, and on macOS Quit has to mean Quit.
        exitApp: () => exitAfterInferenceShutdown(() => exit(0)),
        confirmQuit: () => askQuit("quit"),
        confirmQuitWithoutSaving: () => askQuit("unsaved"),
        resumeAfterFailedShutdown: async () => {
          await operations.resumeAfterFailedShutdown();
          await resumeLocalInference();
        },
        onError,
      });

      // Resolved before the listener is attached so the first close request
      // already knows which convention to follow; "macos" is only assumed when
      // the host actually says so.
      void invoke<string>("host_os").catch(() => "").then((hostOs) => {
        if (disposed) return;
        const close = createCloseRequestHandler({
          hostOs,
          hideWindow: () => appWindow.hide(),
          quit: () => shutdown.request(),
          onError,
        });
        return appWindow.onCloseRequested((event) => {
          void close(event);
        }).then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
      }).catch((error) => {
        console.error("Could not prepare the safe close path:", error);
      });
    }

    return () => {
      disposed = true;
      unlisten?.();
      library.setPersistenceDirtyNotifier(null);
      uiLocale.setPersistenceDirtyNotifier(null);
      libraryPersistence.unregister();
      settingsPersistence.unregister();
    };
  });

  $effect(() => {
    // Reading both axes keeps mismatch fallback copy synchronized with the UI
    // language while startup waits only for the locale loader itself.
    uiLocale.current;
    const localeReady = uiLocale.loaded;
    untrack(() => releaseNotes.setUiReady(localeReady));
  });

  // Resolve "system" against the OS preference, live.
  $effect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = uiLocale.theme === "dark" ||
        (uiLocale.theme === "system" && media.matches);
      document.documentElement.dataset["theme"] = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  });
</script>

{#if releaseNotes.presentation}
  <ReleaseNotesModal
    version={releaseNotes.presentation.version}
    body={releaseNotes.presentation.body}
    onClose={() => releaseNotes.dismiss()}
  />
{/if}

{#if quitPrompt}
  <Modal
    title={quitPrompt.kind === "unsaved"
      ? m.quit_unsaved_title()
      : m.quit_confirm_title()}
    size="sm"
    dismissOnOverlay={false}
    onClose={() => answerQuit(false)}
  >
    <p class="quit-body">
      {quitPrompt.kind === "unsaved"
        ? m.quit_unsaved_body()
        : m.quit_confirm_body()}
    </p>
    {#snippet footer()}
      <button class="btn btn-secondary" onclick={() => answerQuit(false)}>
        {m.quit_cancel()}
      </button>
      <button class="btn btn-primary" onclick={() => answerQuit(true)}>
        {quitPrompt?.kind === "unsaved"
          ? m.quit_unsaved_action()
          : m.quit_confirm_action()}
      </button>
    {/snippet}
  </Modal>
{/if}

{@render children()}
