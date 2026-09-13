// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import type { Essay } from "$lib/model/essay";
import EditorScreen from "$lib/components/EditorScreenReleaseNotesHarness.test.svelte";

declare const __TESINA_SPELLING_PROOF_TEST__: boolean;

const runtime = vi.hoisted(() => ({
  editors: [] as TiptapEditor[],
  persist: vi.fn(),
  capability: vi.fn(),
  check: vi.fn(),
}));

vi.mock("$lib/editor/createEditor", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/editor/createEditor")
  >(
    "$lib/editor/createEditor",
  );
  return {
    ...actual,
    createTesinaEditor(args: Parameters<typeof actual.createTesinaEditor>[0]) {
      const editor = actual.createTesinaEditor({
        ...args,
        paginationEnv: null,
      });
      runtime.editors.push(editor);
      return editor;
    },
  };
});

vi.mock("$lib/spelling/service", () => ({
  createTauriSpellingClient: vi.fn(),
  createSpellingService: vi.fn(() => ({
    capability: runtime.capability,
    check: runtime.check,
  })),
}));

vi.mock("$lib/state/essays.svelte", () => ({
  essays: { persist: runtime.persist },
}));

vi.mock("$lib/state/library.svelte", () => ({
  library: {
    references: [],
    byId: () => new Map(),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("$lib/export/exportEssay", () => ({
  exportEssayToDocx: vi.fn(),
}));

vi.mock("$lib/export/exportPdf", () => ({
  exportEssayToPdf: vi.fn(),
}));

vi.mock("$lib/state/uiLocale.svelte", () => ({
  uiLocale: {
    current: "en",
    theme: "system",
    dock: "bottom",
    spellingEnabled: true,
    personalDictionaries: { en: [], es: [] },
    cycleTheme: vi.fn(),
    setDock: vi.fn(),
    setSpellingEnabled: vi.fn(),
    addPersonalDictionaryTerm: vi.fn(() => "added"),
    setPersonalDictionary: vi.fn(() => true),
    clearPersonalDictionary: vi.fn(),
  },
}));

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

function essay(): Essay {
  return {
    schemaVersion: 2,
    id: "real-editor-screen-spelling",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    settings: {
      documentLanguage: "en",
      variant: "student",
      font: "times-new-roman-12",
      paperSize: "us-letter",
      includeUncitedReferences: false,
    },
    titlePage: {
      title: "Clean title",
      authors: ["Alex Rivera"],
      affiliations: ["Example University"],
    },
    content: {
      type: "doc",
      content: [{
        type: "sectionBody",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Clean body." }],
        }],
      }],
    },
    referencesSnapshot: [],
  };
}

afterEach(() => {
  for (const editor of runtime.editors) editor.destroy();
  runtime.editors = [];
  runtime.persist.mockReset();
  runtime.capability.mockReset();
  runtime.check.mockReset();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("mounts the real EditorScreen with the selected compile-time spelling addon", async () => {
  vi.useFakeTimers();
  runtime.capability.mockResolvedValue({
    status: "available",
    language: "en",
    selectedLanguageTag: "en",
  });
  runtime.check.mockImplementation((
    input: { text: string; documentRevision: number },
  ) =>
    Promise.resolve({
      status: "completed",
      requestId: input.text,
      documentRevision: input.documentRevision,
      selectedLanguageTag: "en",
      issues: [],
    })
  );

  const component = mount(EditorScreen, {
    target: document.body,
    props: {
      essay: essay(),
      newlyCreated: false,
      onLaunchConsumed: vi.fn(),
      onBack: vi.fn(),
      onOpenLibrary: vi.fn(),
    },
  });
  flushSync();
  await vi.advanceTimersByTimeAsync(350);

  expect(runtime.editors).toHaveLength(1);
  if (__TESINA_SPELLING_PROOF_TEST__) {
    expect(document.querySelector("[data-spelling-status]")).not.toBeNull();
    expect(runtime.capability).toHaveBeenCalledWith("en");
    expect(runtime.check).toHaveBeenCalled();
  } else {
    expect(document.querySelector("[data-spelling-status]")).toBeNull();
    expect(runtime.capability).not.toHaveBeenCalled();
    expect(runtime.check).not.toHaveBeenCalled();
  }

  await unmount(component);
});
