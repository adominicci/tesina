// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import type { Content, Editor as TiptapEditor } from "@tiptap/core";
import { exportDocx } from "@tesina/docx-export";
import { checkApaDocument, NODE_NAMES, type Reference } from "@tesina/engine";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { undoDepth } from "@tiptap/pm/history";
import type { Essay } from "$lib/model/essay";
import { m } from "$lib/paraglide/messages";
import { setLocale } from "$lib/paraglide/runtime";
import { createAutosaveController } from "$lib/persist/autosaveController.svelte";
import { persistence } from "$lib/persist/coordinator";
import { UpdaterStore } from "$lib/state/updater.svelte";
import {
  readPendingReleaseNotes,
  type ReleaseNotesStorage,
} from "$lib/update/releaseNotes";
import { bundledReleaseNotes } from "$lib/update/bundledReleaseNotes";
import { createReleaseNotesController } from "$lib/update/releaseNotesController.svelte";
import EditorScreen from "./EditorScreenReleaseNotesHarness.test.svelte";
import type {
  PaginationEnvironment,
  StablePaginationPlan,
} from "$lib/editor/pagination/types";
import { studentTitlePageWarnings } from "$lib/model/titlePageValidation";

const canonicalNotesExcerpt = bundledReleaseNotes.body
  .split("\n")
  .find((line) => line.startsWith("- "))!
  .slice(2);

const runtime = vi.hoisted(() => ({
  editors: [] as TiptapEditor[],
  persist: vi.fn(),
  persistedDocs: [] as unknown[],
  libraryReferences: [] as Reference[],
  exportEssayToDocx: vi.fn(),
  exportEssayToPdf: vi.fn(),
  paginationEnvs: [] as PaginationEnvironment[],
  paginationInvalidations: [] as string[],
  citationLocales: [] as string[],
  referenceLocales: [] as string[],
  referenceEmptyLabels: [] as string[],
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

vi.mock("$lib/editor/createEditor", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/editor/createEditor")
  >("$lib/editor/createEditor");
  return {
    ...actual,
    createTesinaEditor(
      args: Parameters<typeof actual.createTesinaEditor>[0],
    ) {
      if (args.paginationEnv) runtime.paginationEnvs.push(args.paginationEnv);
      runtime.citationLocales.push(args.citationEnv.locale);
      runtime.referenceLocales.push(args.referenceEnv.locale);
      runtime.referenceEmptyLabels.push(args.referenceEnv.emptyLabel);
      const editor = actual.createTesinaEditor({
        ...args,
        // jsdom has no layout engine; the lifecycle contract is exercised by
        // driving the captured production environment below.
        paginationEnv: null,
      });
      runtime.editors.push(editor);
      return editor;
    },
  };
});

vi.mock("$lib/editor/pagination/extension", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/editor/pagination/extension")
  >("$lib/editor/pagination/extension");
  return {
    ...actual,
    invalidatePagination(
      editor: Parameters<typeof actual.invalidatePagination>[0],
      reason: Parameters<typeof actual.invalidatePagination>[1],
    ) {
      runtime.paginationInvalidations.push(reason);
      return actual.invalidatePagination(editor, reason);
    },
  };
});

vi.mock("$lib/state/essays.svelte", () => ({
  essays: { persist: runtime.persist },
}));

vi.mock("$lib/state/library.svelte", () => ({
  library: {
    get references() {
      return runtime.libraryReferences;
    },
    byId: () => new Map(runtime.libraryReferences.map((ref) => [ref.id, ref])),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("$lib/export/exportEssay", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/export/exportEssay")
  >(
    "$lib/export/exportEssay",
  );
  return { ...actual, exportEssayToDocx: runtime.exportEssayToDocx };
});

vi.mock("$lib/export/exportPdf", () => ({
  exportEssayToPdf: runtime.exportEssayToPdf,
}));

vi.mock("$lib/state/uiLocale.svelte", () => ({
  uiLocale: {
    current: "es",
    theme: "system",
    dock: "bottom",
    cycleTheme: vi.fn(),
    setDock: vi.fn(),
  },
}));

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

function bodyDoc(text: string): Content {
  return {
    type: "doc",
    content: [{
      type: NODE_NAMES.sectionBody,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text }],
      }],
    }],
  };
}

function authoredBodyTitleDoc(title: string): Content {
  return {
    type: "doc",
    content: [{
      type: NODE_NAMES.sectionBody,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: title }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Editable authored opening" }],
        },
      ],
    }],
  };
}

function citationDoc(refId: string): Content {
  return {
    type: "doc",
    content: [{
      type: NODE_NAMES.sectionBody,
      content: [{
        type: "paragraph",
        content: [{
          type: "citation",
          attrs: {
            mode: "parenthetical",
            items: [{ refId }],
          },
        }],
      }],
    }],
  };
}

function reference(
  id: string,
  title = "Evidence-based teaching",
): Reference {
  return {
    id,
    type: "website",
    authors: [{ kind: "person", family: "Rivera", given: "Alex" }],
    date: { year: 2026 },
    title,
    siteName: "Teaching Lab",
    url: `https://example.test/${id}`,
  };
}

function docText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const node = doc as { text?: string; content?: unknown[] };
  return [node.text ?? "", ...(node.content ?? []).map(docText)].join("");
}

function essayWithBody(text: string): Essay {
  return {
    schemaVersion: 2,
    id: "preview-round-trip",
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    settings: {
      documentLanguage: "en",
      variant: "student",
      font: "times-new-roman-12",
      paperSize: "us-letter",
      includeUncitedReferences: false,
    },
    titlePage: {
      title: "Preview round trip",
      authors: ["Alex Rivera"],
      affiliations: ["Example University"],
    },
    content: bodyDoc(text),
    referencesSnapshot: [],
  };
}

function exportableEssay(content: Content): Essay {
  const essay = essayWithBody("Seed");
  essay.content = content;
  essay.titlePage = {
    ...essay.titlePage,
    course: "EDU 301: Foundations of Education",
    instructor: "Dr. Rivera",
    dueDate: "2026-08-07",
  };
  return essay;
}

function exportButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '.fm-primary-action[aria-label="Exportar"]',
  );
  if (!button) throw new Error("Export button not found");
  return button;
}

/** Opens the export menu and picks a format, as a user must. */
function exportAs(format: "docx" | "pdf"): void {
  exportButton().click();
  flushSync();
  const label = format === "pdf"
    ? m.editor_export_pdf()
    : m.editor_export_docx();
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>(".export-menu button"),
  ].find((button) => button.textContent?.trim() === label);
  if (!item) throw new Error(`Export menu item not found: ${label}`);
  item.click();
  flushSync();
}

afterEach(() => {
  vi.useRealTimers();
  runtime.editors = [];
  runtime.persist.mockReset();
  runtime.persistedDocs = [];
  runtime.libraryReferences = [];
  runtime.exportEssayToDocx.mockReset();
  runtime.exportEssayToDocx.mockResolvedValue({ status: "cancelled" });
  runtime.exportEssayToPdf.mockReset();
  runtime.exportEssayToPdf.mockResolvedValue({ status: "cancelled" });
  runtime.paginationEnvs = [];
  runtime.paginationInvalidations = [];
  runtime.citationLocales = [];
  runtime.referenceLocales = [];
  runtime.referenceEmptyLabels = [];
  setLocale("es", { reload: false });
  document.body.replaceChildren();
});

describe("Write and Study workspace modes", () => {
  it("defaults to Write and replaces it with Study while the editor stays mounted and inert", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody(
          "It is important to note that the policy changed in many ways during review.",
        ),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const mode = document.querySelector(
      `[aria-label="${m.writing_coach_mode_label()}"]`,
    );
    expect(mode).not.toBeNull();
    const write = [...mode!.querySelectorAll("button")].find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_write()
    )!;
    const study = [...mode!.querySelectorAll("button")].find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_study()
    )!;
    expect(write.getAttribute("aria-pressed")).toBe("true");
    expect(study.getAttribute("aria-pressed")).toBe("false");
    expect(runtime.editors).toHaveLength(1);
    const editor = runtime.editors[0]!;
    const beforeJson = JSON.stringify(editor.getJSON());
    const beforeUndo = undoDepth(editor.state);

    study.click();
    await drainMicrotasks();
    flushSync();
    expect(study.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-coach-workspace]")).not.toBeNull();
    const writeWorkspace = document.querySelector("[data-write-workspace]");
    expect(writeWorkspace?.getAttribute("aria-hidden")).toBe("true");
    expect((writeWorkspace as HTMLElement & { inert: boolean }).inert).toBe(
      true,
    );
    expect(runtime.editors).toHaveLength(1);
    expect(document.querySelector(
      `[aria-label="${m.apa_check_menu_label()}"]`,
    )).toBeNull();

    write.click();
    await tick();
    flushSync();
    expect(write.getAttribute("aria-pressed")).toBe("true");
    expect(writeWorkspace?.getAttribute("aria-hidden")).toBe("false");
    expect((writeWorkspace as HTMLElement & { inert: boolean }).inert).toBe(
      false,
    );
    expect(JSON.stringify(editor.getJSON())).toBe(beforeJson);
    expect(undoDepth(editor.state)).toBe(beforeUndo);
    await unmount(component);
  });

  it("moves focus only on user entry and preserves focused Study controls during background analysis", async () => {
    const essay = essayWithBody("Seed");
    essay.content = {
      type: "doc",
      content: [{
        type: NODE_NAMES.sectionBody,
        content: [
          {
            type: "paragraph",
            content: [{
              type: "text",
              text:
                "It is important to note that the policy changed in many ways during review.",
            }],
          },
          {
            type: "paragraph",
            content: [{
              type: "text",
              text: "A separate paragraph records the committee result.",
            }],
          },
        ],
      }],
    };
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const study = [
      ...document.querySelectorAll<HTMLButtonElement>(".coach-mode button"),
    ].find(
      (item) => item.textContent?.trim() === m.writing_coach_mode_study(),
    )!;
    study.click();
    await drainMicrotasks();
    flushSync();
    expect(document.activeElement).toBe(
      document.querySelector("#writing-coach-heading"),
    );
    const next = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.trim() === m.writing_coach_next()
    ) as HTMLButtonElement;
    next.focus();
    let secondParagraphPosition = -1;
    let paragraphIndex = 0;
    runtime.editors[0]!.state.doc.descendants((node, position) => {
      if (node.type.name !== "paragraph") return;
      if (paragraphIndex === 1) secondParagraphPosition = position;
      paragraphIndex += 1;
    });
    expect(secondParagraphPosition).toBeGreaterThan(0);
    runtime.editors[0]!.commands.insertContentAt(
      secondParagraphPosition + 1,
      "Earlier, ",
    );
    await drainMicrotasks();
    flushSync();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      m.writing_coach_status_analyzing(),
    );
    expect(document.activeElement).toBe(next);
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]'))
      .toHaveLength(1);
    await unmount(component);
  });

  it("announces stale Edit navigation after Write opens without selecting or changing text", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody(
          "The policy changed in many ways during review.",
        ),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const editor = runtime.editors[0]!;
    const beforeJson = JSON.stringify(editor.getJSON());
    const beforeSelection = editor.state.selection.toJSON();
    const mountedWriteStatus = document.querySelector(
      "[data-coach-write-status]",
    );
    expect(mountedWriteStatus).not.toBeNull();
    expect(mountedWriteStatus?.textContent).toBe("");
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]'))
      .toHaveLength(1);
    [...document.querySelectorAll<HTMLButtonElement>(".coach-mode button")]
      .find((item) =>
        item.textContent?.trim() === m.writing_coach_mode_study()
      )!.click();
    await drainMicrotasks();
    flushSync();

    editor.destroy();
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) =>
        item.textContent?.trim() === m.writing_coach_edit_passage()
      )!.click();
    await drainMicrotasks();
    flushSync();

    expect(document.querySelector("[data-coach-workspace]")).toBeNull();
    expect(document.querySelector("[data-coach-write-status]")?.textContent)
      .toContain(m.writing_coach_status_stale());
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]'))
      .toHaveLength(1);
    expect(editor.state.selection.toJSON()).toEqual(beforeSelection);
    expect(JSON.stringify(editor.getJSON())).toBe(beforeJson);
    expect(document.querySelector(".writing-coach-source-emphasis")).toBeNull();

    [...document.querySelectorAll<HTMLButtonElement>(".coach-mode button")]
      .find((item) =>
        item.textContent?.trim() === m.writing_coach_mode_study()
      )!.click();
    await drainMicrotasks();
    flushSync();
    expect(document.querySelector("[data-coach-workspace]")).not.toBeNull();
    expect(document.querySelector("[data-coach-source]")?.textContent)
      .toContain("in many ways");
    await unmount(component);
  });

  it("does not restore a prior fixed selection after Write or preview exits", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody(
          "It is important to note that the policy changed in many ways during review.",
        ),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const modes = [...document.querySelectorAll<HTMLButtonElement>(
      ".coach-mode button",
    )];
    const write = modes.find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_write()
    )!;
    const study = modes.find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_study()
    )!;
    const next = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === m.writing_coach_next(),
      )!;
    const count = () =>
      document.querySelector("[data-coach-count]")?.textContent;

    study.click();
    await drainMicrotasks();
    flushSync();
    next().click();
    flushSync();
    expect(count()).toBe(m.writing_coach_position({ position: 2, total: 2 }));
    write.click();
    flushSync();
    study.click();
    await drainMicrotasks();
    flushSync();
    expect(count()).toBe(m.writing_coach_position({ position: 1, total: 2 }));

    next().click();
    flushSync();
    const preview = document.querySelector<HTMLButtonElement>(
      `[aria-label="${m.tb_preview()}"]`,
    )!;
    preview.click();
    flushSync();
    preview.click();
    flushSync();
    study.click();
    await drainMicrotasks();
    flushSync();
    expect(count()).toBe(m.writing_coach_position({ position: 1, total: 2 }));
    await unmount(component);
  });

  it("starts a fresh Write session with no issue, suppression, focus, or emphasis after an essay remount", async () => {
    const firstEssay = essayWithBody(
      "It is important to note that the policy changed in many ways during review.",
    );
    firstEssay.id = "coach-essay-one";
    const first = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: firstEssay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const study = [...document.querySelectorAll<HTMLButtonElement>(
      ".coach-mode button",
    )].find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_study()
    )!;
    study.click();
    await drainMicrotasks();
    flushSync();
    document.querySelector<HTMLButtonElement>(
      ".actions .quiet",
    )!.click();
    flushSync();
    expect(document.querySelector("[data-coach-count]")?.textContent).toContain(
      "1",
    );
    await unmount(first);
    document.body.replaceChildren();

    const secondEssay = essayWithBody(
      "It is important to note that the policy changed in many ways during review.",
    );
    secondEssay.id = "coach-essay-two";
    const second = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: secondEssay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const modes = [...document.querySelectorAll<HTMLButtonElement>(
      ".coach-mode button",
    )];
    expect(
      modes.find((item) =>
        item.textContent?.trim() === m.writing_coach_mode_write()
      )?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.querySelector("[data-coach-workspace]")).toBeNull();
    expect(document.querySelector(".writing-coach-source-emphasis")).toBeNull();

    modes.find((item) =>
      item.textContent?.trim() === m.writing_coach_mode_study()
    )!.click();
    await drainMicrotasks();
    flushSync();
    expect(document.querySelector("[data-coach-count]")?.textContent).toBe(
      m.writing_coach_position({ position: 1, total: 2 }),
    );
    expect(document.activeElement).toBe(
      document.querySelector("#writing-coach-heading"),
    );
    await unmount(second);
  });

  it("keeps coach review out of persistence, storage, network, APA, schema, history, and export bytes", async () => {
    setLocale("es", { reload: false });
    const essay = exportableEssay(bodyDoc(
      "It is important to note that the policy changed in many ways during review.",
    ));
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const editor = runtime.editors[0]!;
    const exportBytes = (content: unknown) =>
      exportDocx({
        content,
        settings: {
          documentLanguage: essay.settings.documentLanguage,
          variant: essay.settings.variant,
          font: essay.settings.font,
          paperSize: essay.settings.paperSize,
        },
        titlePage: essay.titlePage,
        references: [],
      });
    const beforeDocument = JSON.stringify(editor.getJSON());
    const beforeEssay = JSON.stringify(essay);
    const beforeSchema = Object.keys(editor.schema.nodes);
    const beforeUndo = undoDepth(editor.state);
    const beforeApa = checkApaDocument(editor.getJSON());
    const beforeEligibility = studentTitlePageWarnings(
      essay.titlePage,
      essay.settings.documentLanguage,
    );
    const beforeBytes = await exportBytes(editor.getJSON());
    runtime.persist.mockReset();
    runtime.exportEssayToDocx.mockReset();
    runtime.exportEssayToPdf.mockReset();
    const localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    const fetchCall = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const clickCoach = (label: string) => {
      const action = [...document.querySelectorAll<HTMLButtonElement>(
        "button",
      )].find((item) => item.textContent?.trim() === label);
      if (!action) throw new Error(`missing coach action: ${label}`);
      action.click();
    };
    clickCoach(m.writing_coach_mode_study());
    await drainMicrotasks();
    flushSync();
    clickCoach(m.writing_coach_next());
    clickCoach(m.writing_coach_previous());
    clickCoach(m.writing_coach_edit_passage());
    await vi.waitFor(() =>
      expect(document.querySelector(".writing-coach-source-emphasis"))
        .not.toBeNull()
    );
    flushSync();
    clickCoach(m.writing_coach_mode_study());
    await drainMicrotasks();
    flushSync();
    clickCoach(m.writing_coach_not_helpful());
    clickCoach(m.writing_coach_dismiss());
    clickCoach(m.writing_coach_mode_write());
    await tick();

    expect(JSON.stringify(editor.getJSON())).toBe(beforeDocument);
    expect(JSON.stringify(essay)).toBe(beforeEssay);
    expect(Object.keys(editor.schema.nodes)).toEqual(beforeSchema);
    expect(undoDepth(editor.state)).toBe(beforeUndo);
    expect(checkApaDocument(editor.getJSON())).toEqual(beforeApa);
    expect(studentTitlePageWarnings(
      essay.titlePage,
      essay.settings.documentLanguage,
    )).toEqual(beforeEligibility);
    const beforeArchive = unzipSync(beforeBytes);
    const afterArchive = unzipSync(await exportBytes(editor.getJSON()));
    expect(afterArchive["word/document.xml"]).toEqual(
      beforeArchive["word/document.xml"],
    );
    expect(afterArchive["word/styles.xml"]).toEqual(
      beforeArchive["word/styles.xml"],
    );
    expect(runtime.persist).not.toHaveBeenCalled();
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();
    expect(runtime.exportEssayToPdf).not.toHaveBeenCalled();
    expect(localStorageWrite).not.toHaveBeenCalled();
    expect(fetchCall).not.toHaveBeenCalled();

    editor.commands.insertContentAt(2, "Student revision: ");
    expect(JSON.stringify(editor.getJSON())).not.toBe(beforeDocument);
    localStorageWrite.mockRestore();
    fetchCall.mockRestore();
    await unmount(component);
  });

  it("keeps UI and document language axes crossed through Study and preview", async () => {
    setLocale("en", { reload: false });
    const spanishEssay = essayWithBody(
      "Cabe señalar que la política cambió de alguna manera durante la revisión.",
    );
    spanishEssay.settings.documentLanguage = "es";
    const spanishComponent = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: spanishEssay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>(".coach-mode button")]
      .find((item) =>
        item.textContent?.trim() ===
          m.writing_coach_mode_study(undefined, { locale: "en" })
      )!.click();
    await drainMicrotasks();
    flushSync();
    expect(document.querySelector("[data-coach-source]")?.textContent)
      .toContain("la política cambió de alguna manera");
    expect(document.querySelector(".category")?.textContent).toBe(
      m.writing_coach_category_voice(undefined, { locale: "en" }),
    );
    const preview = document.querySelector<HTMLButtonElement>(
      `[aria-label="${m.tb_preview(undefined, { locale: "en" })}"]`,
    )!;
    preview.click();
    flushSync();
    expect(document.querySelector("[data-coach-workspace]")).toBeNull();
    expect(document.querySelector(".preview-host")).not.toBeNull();
    await unmount(spanishComponent);
    document.body.replaceChildren();

    setLocale("es", { reload: false });
    const englishEssay = essayWithBody(
      "It is important to note that the policy changed in many ways during review.",
    );
    const englishComponent = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: englishEssay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>(".coach-mode button")]
      .find((item) =>
        item.textContent?.trim() ===
          m.writing_coach_mode_study(undefined, { locale: "es" })
      )!.click();
    await drainMicrotasks();
    flushSync();
    expect(document.querySelector("[data-coach-source]")?.textContent)
      .toContain("the policy changed in many ways");
    expect(document.querySelector(".category")?.textContent).toBe(
      m.writing_coach_category_voice(undefined, { locale: "es" }),
    );
    await unmount(englishComponent);
  });
});

describe("outline Add menu dismissal", () => {
  function mountEditor() {
    return mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed"),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
  }

  function addTrigger(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
      `.add-wrap > button[aria-label="${m.outline_add()}"]`,
    );
    if (!button) throw new Error("Outline Add button not found");
    return button;
  }

  function addMenu(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".add-wrap [role='menu']");
  }

  it("dismisses on an outside pointer press", async () => {
    const component = mountEditor();
    flushSync();

    addTrigger().click();
    flushSync();
    expect(addMenu()).not.toBeNull();

    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    flushSync();
    expect(addMenu()).toBeNull();

    await unmount(component);
  });

  it("uses document English for citation and reference environments under Spanish UI", async () => {
    const component = mountEditor();
    flushSync();
    expect(runtime.citationLocales).toEqual(["en"]);
    expect(runtime.referenceLocales).toEqual(["en"]);
    expect(runtime.referenceEmptyLabels).toEqual([
      m.refsheet_empty(undefined, { locale: "en" }),
    ]);
    await unmount(component);
  });

  it("dismisses on Escape and returns focus to the Add button", async () => {
    const component = mountEditor();
    flushSync();

    const trigger = addTrigger();
    trigger.click();
    flushSync();
    addMenu()?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();

    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    flushSync();
    expect(addMenu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await unmount(component);
  });

  it("keeps menu-item actions working while dismissable", async () => {
    const component = mountEditor();
    flushSync();

    addTrigger().click();
    flushSync();
    const addAbstract = [...document.querySelectorAll<HTMLButtonElement>(
      ".add-wrap [role='menuitem']",
    )].find((button) => button.textContent?.trim() === m.editor_add_abstract());
    if (!addAbstract) throw new Error("Add abstract item not found");
    addAbstract.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    flushSync();
    expect(addMenu()).not.toBeNull();
    addAbstract.click();
    flushSync();

    expect(addMenu()).toBeNull();
    expect(runtime.editors[0]?.getJSON().content?.[0]?.type).toBe(
      "sectionAbstract",
    );

    await unmount(component);
  });
});

describe("editor preview round trip", () => {
  it("shows a native installed-version button beside APA 7 in the status bar", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed"),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    const versionButton = document.querySelector<HTMLButtonElement>(
      ".statusbar button[data-release-notes-version]",
    );
    expect(versionButton).not.toBeNull();
    expect(versionButton?.type).toBe("button");
    expect(versionButton?.textContent).toBe(
      `v${bundledReleaseNotes.version}`,
    );
    expect(versionButton?.title).toBe(
      `Novedades de Tesina ${bundledReleaseNotes.version}`,
    );
    expect(versionButton?.getAttribute("aria-label")).toBe(
      `Abrir las notas de Tesina ${bundledReleaseNotes.version}`,
    );
    expect(versionButton?.previousElementSibling?.textContent).toBe("APA 7");

    document.querySelector<HTMLButtonElement>(
      `.fm-btn[aria-label="${m.fab_focus()}"]`,
    )!.click();
    flushSync();
    expect(document.querySelector(".statusbar")?.classList).toContain("dim");
    expect(versionButton?.isConnected).toBe(true);
    await unmount(component);
  });

  it("opens the canonical installed notes from the editor without changing the essay", async () => {
    const essay = essayWithBody("Canonical-note identity");
    const before = structuredClone(essay);
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    const authoredJson = JSON.stringify(runtime.editors[0]!.getJSON());
    const versionButton = document.querySelector<HTMLButtonElement>(
      ".statusbar button[data-release-notes-version]",
    )!;
    expect(versionButton.type).toBe("button");
    versionButton.focus();
    versionButton.click();
    flushSync();

    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog?.textContent).toContain(
      `Tesina ${bundledReleaseNotes.version}`,
    );
    expect(dialog?.textContent).toContain(canonicalNotesExcerpt);
    document.querySelector<HTMLButtonElement>(".modal .btn-primary")!.click();
    flushSync();
    expect(document.activeElement).toBe(versionButton);
    expect(JSON.stringify(runtime.editors[0]!.getJSON())).toBe(authoredJson);
    expect(essay).toEqual(before);
    await unmount(component);
  });

  it("opens mismatch-safe notes and returns focus without navigation or essay mutation", async () => {
    const releaseNotesController = createReleaseNotesController({
      bundled: bundledReleaseNotes,
      getRuntimeVersion: () => Promise.resolve("9.8.7"),
      getStorage: () => null,
      unavailableBody: () =>
        "Las notas no están disponibles para esta versión.",
    });
    releaseNotesController.setUiReady(true);
    await releaseNotesController.resolveRuntimeVersion();
    const essay = essayWithBody("Identity-safe body");
    const essayBefore = structuredClone(essay);
    const onBack = vi.fn();
    const onOpenLibrary = vi.fn();
    const initialLocation = globalThis.location.href;
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack,
        onOpenLibrary,
        releaseNotesController,
      },
    });
    flushSync();
    const authoredJson = JSON.stringify(runtime.editors[0]!.getJSON());

    const versionButton = document.querySelector<HTMLButtonElement>(
      ".statusbar button[data-release-notes-version]",
    )!;
    expect(versionButton.textContent).toBe("v9.8.7");
    expect(versionButton.title).toBe("Novedades de Tesina 9.8.7");
    versionButton.focus();
    versionButton.click();
    flushSync();

    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog?.textContent).toContain("Tesina 9.8.7");
    expect(dialog?.textContent).toContain(
      "Las notas no están disponibles para esta versión.",
    );
    expect(dialog?.textContent).not.toContain(canonicalNotesExcerpt);
    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(dialog?.contains(document.activeElement)).toBe(true);

    document.querySelector<HTMLButtonElement>(".modal .btn-primary")!.click();
    flushSync();
    expect(document.activeElement).toBe(versionButton);

    versionButton.click();
    flushSync();
    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "Las notas no están disponibles para esta versión.",
    );
    expect(JSON.stringify(runtime.editors[0]!.getJSON())).toBe(authoredJson);
    expect(essay).toEqual(essayBefore);
    expect(globalThis.location.href).toBe(initialLocation);
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenLibrary).not.toHaveBeenCalled();
    await unmount(component);
  });

  it("shows localized live pagination lifecycle without a words-based estimate", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed ".repeat(900)),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    await tick();

    const pageStatus = () =>
      document.querySelector<HTMLElement>("[data-live-page-status]")
        ?.textContent?.trim();
    expect(pageStatus()).toBe(m.status_pages_pending());
    expect(pageStatus()).not.toBe(m.status_pages_many({ count: 4 }));

    const environment = runtime.paginationEnvs[0]!;
    environment.onPageCount?.({
      status: "fallback",
      epoch: 1,
      reason: "canonical-layout",
      pageCount: null,
      visiblePlan: null,
      lastStablePlan: null,
    });
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_unavailable());

    const plan: StablePaginationPlan = {
      status: "stable",
      epoch: 2,
      pageStarts: [
        { pageIndex: 0, pos: 1, section: "body", kind: "section" },
        { pageIndex: 1, pos: 20, section: "body", kind: "line" },
      ],
      pageGaps: [],
      tableRowStarts: [],
      overflows: [],
      pageCount: {
        authored: 2,
        references: 1,
        total: 3,
        bySection: { abstract: 0, body: 2, appendix: 0, references: 1 },
      },
    };
    environment.onPageCount?.({
      status: "stable",
      epoch: 2,
      reason: "authored-content",
      pageCount: plan.pageCount,
      visiblePlan: plan,
      lastStablePlan: plan,
    });
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 4 }));

    runtime.editors[0]!.commands.insertContentAt(2, "Page-growing edit ");
    const editedJson = JSON.stringify(runtime.editors[0]!.getJSON());
    expect(editedJson).toContain("Page-growing edit");
    const expandedPlan: StablePaginationPlan = {
      ...plan,
      epoch: 3,
      pageStarts: [
        ...plan.pageStarts,
        { pageIndex: 2, pos: 30, section: "body", kind: "line" },
      ],
      pageCount: {
        authored: 3,
        references: 1,
        total: 4,
        bySection: { abstract: 0, body: 3, appendix: 0, references: 1 },
      },
    };
    environment.onPageCount?.({
      status: "settling",
      epoch: 3,
      reason: "authored-content",
      pageCount: plan.pageCount,
      visiblePlan: plan,
      lastStablePlan: plan,
    });
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 4 }));
    environment.onPageCount?.({
      status: "stable",
      epoch: 3,
      reason: "authored-content",
      pageCount: expandedPlan.pageCount,
      visiblePlan: expandedPlan,
      lastStablePlan: expandedPlan,
    });
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 5 }));

    environment.onPageCount?.({
      status: "settling",
      epoch: 4,
      reason: "font",
      pageCount: expandedPlan.pageCount,
      visiblePlan: expandedPlan,
      lastStablePlan: expandedPlan,
    });
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 5 }));

    const previewButton = document.querySelector<HTMLButtonElement>(
      ".tb-actions button:nth-child(3)",
    )!;
    previewButton.click();
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 5 }));
    previewButton.click();
    flushSync();
    expect(pageStatus()).toBe(m.status_pages_many({ count: 5 }));

    const outer = document.querySelector<HTMLElement>(".paper-scale-outer");
    const inner = document.querySelector<HTMLElement>(".paper-scale-inner");
    expect(outer?.style.width).toBe("816px");
    expect(inner?.style.width).toBe("816px");
    expect(inner?.style.transform).toBe("scale(1)");
    await unmount(component);
  });

  it("fits narrow and wide canvases without repaginating for panel or focus changes", async () => {
    let availableWidth = 612;
    const observerCallbacks: Array<() => void> = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const clientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallbacks.push(() => callback([], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList.contains("paper-fit-viewport")
          ? availableWidth
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("paper-scale-inner") ? 2112 : 0;
      },
    });
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed"),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    try {
      flushSync();
      expect(
        document.querySelector<HTMLElement>(".paper-scale-inner")?.style
          .transform,
      ).toBe("scale(0.75)");
      expect(
        document.querySelector<HTMLElement>(".paper-scale-outer")?.style
          .height,
      ).toBe("1584px");
      expect(
        document.querySelector<HTMLButtonElement>(
          ".statusbar button[data-release-notes-version]",
        )?.type,
      ).toBe("button");

      availableWidth = 816;
      document.querySelector<HTMLButtonElement>(
        ".tb-actions button:nth-child(2)",
      )!.click();
      observerCallbacks.forEach((callback) => callback());
      flushSync();
      expect(
        document.querySelector<HTMLElement>(".paper-scale-inner")?.style
          .transform,
      ).toBe("scale(1)");

      document.querySelector<HTMLButtonElement>(
        `.fm-btn[aria-label="${m.fab_focus()}"]`,
      )!.click();
      flushSync();
      expect(runtime.paginationInvalidations).toEqual([]);
    } finally {
      await unmount(component);
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          value: originalResizeObserver,
        });
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
      if (clientWidth) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientWidth",
          clientWidth,
        );
      }
      if (scrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeight,
        );
      }
    }
  });

  it("suppresses only the pseudo body title for a matching authored H1", async () => {
    const essay = essayWithBody("Seed");
    essay.titlePage.title = "Legacy Body Title";
    essay.content = authoredBodyTitleDoc(essay.titlePage.title);
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });

    try {
      flushSync();
      await tick();
      const sheetStack = document.querySelector<HTMLElement>(".sheet-stack");
      const authoredHeading = document.querySelector<HTMLHeadingElement>(
        ".ProseMirror .sec-body > h1",
      );

      expect(sheetStack?.style.getPropertyValue("--body-title")).toBe("none");
      expect(authoredHeading?.textContent).toBe("Legacy Body Title");
      expect(runtime.editors[0]?.getJSON()).toEqual(essay.content);
    } finally {
      await unmount(component);
    }
  });

  it("repaginates after a cover-title edit updates the generated body heading", async () => {
    const essay = essayWithBody("Seed");
    essay.titlePage.title = "Short title";
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });

    try {
      flushSync();
      await tick();
      runtime.paginationInvalidations = [];

      const title = document.querySelector<HTMLInputElement>(
        ".cover-sheet input.cf.title",
      );
      expect(title).not.toBeNull();
      title!.value =
        "A substantially longer generated body title that wraps onto several lines";
      title!.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      await tick();
      await drainMicrotasks();

      expect(
        document.querySelector<HTMLElement>(".sheet-stack")?.style
          .getPropertyValue("--body-title"),
      ).toContain("substantially longer generated body title");
      expect(runtime.paginationInvalidations).toEqual(["canonical-layout"]);
    } finally {
      await unmount(component);
    }
  });

  it("keeps rapid edits visible and persists both sides of a preview toggle", async () => {
    vi.useFakeTimers();
    runtime.persist.mockImplementation((essay: Essay) => {
      runtime.persistedDocs.push(JSON.parse(JSON.stringify(essay.content)));
    });
    const essay = essayWithBody("Seed");
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    expect(runtime.editors).toHaveLength(1);
    runtime.editors[0]!.commands.setContent(bodyDoc("First edit"));
    flushSync();
    expect(document.querySelector(".ProseMirror")?.textContent).toContain(
      "First edit",
    );

    const previewButton = document.querySelector<HTMLButtonElement>(
      ".tb-actions button:nth-child(3)",
    );
    expect(previewButton).not.toBeNull();
    previewButton!.click();
    flushSync();
    expect(document.querySelector(".ProseMirror")).toBeNull();
    expect(runtime.persist).not.toHaveBeenCalled();

    previewButton!.click();
    flushSync();
    await tick();
    expect(runtime.editors).toHaveLength(2);
    expect(document.querySelector(".ProseMirror")?.textContent).toContain(
      "First edit",
    );

    runtime.editors[1]!.chain().focus("end").insertContent(" Second edit")
      .run();
    flushSync();
    expect(document.querySelector(".ProseMirror")?.textContent).toContain(
      "First edit Second edit",
    );

    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.persistedDocs).toHaveLength(1);
    expect(docText(runtime.persistedDocs[0])).toContain(
      "First edit Second edit",
    );
    await unmount(component);
  });

  it("routes proof-addon document ignores through the canonical essay autosave snapshot", async () => {
    vi.useFakeTimers();
    let persisted: Essay | undefined;
    runtime.persist.mockImplementation((essay: Essay) => {
      persisted = essay;
    });
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed"),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const addon = document.querySelector<HTMLButtonElement>(
      "[data-test-editor-addon]",
    );
    expect(addon?.dataset.hasTitleInput).toBe("true");
    addon!.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(persisted?.spelling?.documentIgnores?.en).toEqual(["Tesina"]);
    await unmount(component);
  });

  it("keeps proof title corrections in the form draft until Save and discards them on Close", async () => {
    vi.useFakeTimers();
    let persisted: Essay | undefined;
    runtime.persist.mockImplementation((essay: Essay) => {
      persisted = essay;
    });
    const essay = essayWithBody("Seed");
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    const addon = document.querySelector<HTMLButtonElement>(
      "[data-test-editor-addon]",
    )!;
    expect(addon.dataset.titleInputOwner).toBe("cover");
    document.querySelector<HTMLButtonElement>(".cover-form-btn")!.click();
    flushSync();
    expect(addon.dataset.titleInputOwner).toBe("form");
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>(
      "[data-test-title-replacement]",
    )!.click();
    flushSync();
    const formTitle = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="text"]',
    )!;
    expect(essay.titlePage.title).toBe("Preview round trip");
    expect(formTitle.value).toBe("Corrected title");
    await vi.advanceTimersByTimeAsync(500);
    expect(persisted).toBeUndefined();

    document.querySelector<HTMLButtonElement>(
      '[role="dialog"] .btn-secondary',
    )!.click();
    flushSync();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(essay.titlePage.title).toBe("Preview round trip");

    document.querySelector<HTMLButtonElement>(".cover-form-btn")!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>(
      "[data-test-title-replacement]",
    )!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>(
      '[role="dialog"] .btn-primary',
    )!.click();
    flushSync();
    expect(essay.titlePage.title).toBe("Corrected title");
    await vi.advanceTimersByTimeAsync(500);
    expect(persisted?.titlePage.title).toBe("Corrected title");
    await unmount(component);
  });
});

describe("autosave controller integration", () => {
  it("keeps close pending until an edit made during the active write is persisted", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void>();
    runtime.persist
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const controller = createAutosaveController({
      persist: runtime.persist,
    });
    const dispose = controller.bindPersistence(persistence);
    controller.scheduleSave();
    let destroyed = false;
    const closing = persistence.flushPending().then(() => {
      destroyed = true;
    });
    await drainMicrotasks();
    expect(runtime.persist).toHaveBeenCalledOnce();

    controller.scheduleSave();
    firstWrite.resolve();
    try {
      await closing;
      expect(runtime.persist).toHaveBeenCalledTimes(2);
      expect(destroyed).toBe(true);
    } finally {
      dispose();
      await drainMicrotasks();
    }
  });

  it("does not queue the current revision twice when autosave is in flight", async () => {
    vi.useFakeTimers();
    const writing = deferred<void>();
    runtime.persist.mockReturnValueOnce(writing.promise);
    const controller = createAutosaveController({
      persist: runtime.persist,
    });
    const dispose = controller.bindPersistence(persistence);
    controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(500);
    const flushing = persistence.flushPending();
    expect(runtime.persist).toHaveBeenCalledOnce();

    writing.resolve();
    try {
      await flushing;
      expect(runtime.persist).toHaveBeenCalledOnce();
    } finally {
      dispose();
      await drainMicrotasks();
    }
  });

  it("retries a transient editor flush without a new edit before updater relaunch", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => {},
    );
    runtime.persist
      .mockRejectedValueOnce(new Error("temporary disk failure"))
      .mockResolvedValueOnce(undefined);
    const storage = new MemoryStorage();
    let relaunches = 0;
    const updater = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Retry-safe persistence",
          downloadAndInstall: () => Promise.resolve(),
        }),
      flushPending: () => persistence.flushPending(),
      storage: () => storage,
      relaunch: () => {
        relaunches += 1;
        return Promise.resolve();
      },
    });
    const controller = createAutosaveController({
      persist: runtime.persist,
    });
    const dispose = controller.bindPersistence(persistence);
    controller.scheduleSave();
    await updater.check();

    try {
      await updater.install();
      expect(updater.status).toBe("error");
      expect(readPendingReleaseNotes(storage)).toBeNull();
      expect(relaunches).toBe(0);

      await updater.install();
      expect(readPendingReleaseNotes(storage)).toEqual({
        version: "0.2.0",
        body: "Retry-safe persistence",
      });
      expect(relaunches).toBe(1);
      expect(runtime.persist).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
      dispose();
      await drainMicrotasks();
    }
  });

  it("shares one persistence barrier between native close and updater relaunch", async () => {
    vi.useFakeTimers();
    const writing = deferred<void>();
    runtime.persist.mockReturnValueOnce(writing.promise);
    const storage = new MemoryStorage();
    const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue();
    const updater = new UpdaterStore({
      check: () =>
        Promise.resolve({
          version: "0.2.0",
          body: "Shared barrier",
          downloadAndInstall: () => Promise.resolve(),
        }),
      flushPending: () => persistence.flushPending(),
      storage: () => storage,
      relaunch,
    });
    const controller = createAutosaveController({
      persist: runtime.persist,
    });
    const dispose = controller.bindPersistence(persistence);
    controller.scheduleSave();
    await updater.check();

    const closing = persistence.flushPending();
    const installing = updater.install();
    await drainMicrotasks();
    expect(runtime.persist).toHaveBeenCalledOnce();

    writing.resolve();
    try {
      await Promise.all([closing, installing]);
      expect(runtime.persist).toHaveBeenCalledOnce();
      expect(relaunch).toHaveBeenCalledOnce();
    } finally {
      dispose();
      await drainMicrotasks();
    }
  });

  it("flushes the latest edit before an app close inside the debounce window", async () => {
    vi.useFakeTimers();
    runtime.persist.mockImplementation((essay: Essay) => {
      runtime.persistedDocs.push(JSON.parse(JSON.stringify(essay.content)));
    });
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: essayWithBody("Seed"),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();
    try {
      runtime.editors[0]!.commands.setContent(bodyDoc("Close-safe edit"));
      flushSync();

      await persistence.flushPending();

      expect(runtime.persist).toHaveBeenCalledOnce();
      expect(docText(runtime.persistedDocs[0])).toContain("Close-safe edit");
    } finally {
      await unmount(component);
    }
  });

  it("serializes rapid edits so an older write cannot commit last", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void>();
    const committed: string[] = [];
    let edit = "Older edit";
    runtime.persist.mockImplementation(() => {
      const seen = edit;
      if (runtime.persist.mock.calls.length === 1) {
        return firstWrite.promise.then(() => {
          committed.push(seen);
        });
      }
      committed.push(seen);
      return Promise.resolve();
    });
    const controller = createAutosaveController({
      persist: runtime.persist,
    });
    const dispose = controller.bindPersistence(persistence);

    controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(500);
    edit = "Newest edit";
    controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(500);

    try {
      expect(runtime.persist).toHaveBeenCalledOnce();
      firstWrite.resolve();
      await vi.waitFor(() => expect(runtime.persist).toHaveBeenCalledTimes(2));
      expect(committed).toEqual(["Older edit", "Newest edit"]);
    } finally {
      dispose();
      await drainMicrotasks();
    }
  });
});

describe("APA export title-page advice", () => {
  /** Mounts an essay whose course lacks the colon APA asks for. */
  function mountIncompleteTitlePage() {
    const essay = exportableEssay(bodyDoc("Seed"));
    essay.titlePage.course = "PSYC 232"; // no colon → APA shortfall
    return mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
  }

  function dialogButton(label: string): HTMLButtonElement {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(".modal .btn"),
    ].find((candidate) => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`Button not found: ${label}`);
    return button;
  }

  async function waitForAdvice() {
    await vi.waitFor(() => {
      expect(document.querySelector(".modal .status-panel[data-tone='warn']"))
        .not.toBeNull();
    });
  }

  it("exports an APA-complete title page without raising advice", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: exportableEssay(bodyDoc("Seed")),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    exportAs("docx");
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });
    expect(document.querySelector(".modal")).toBeNull();

    await unmount(component);
  });

  it("advises instead of blocking, then exports on confirmation", async () => {
    const component = mountIncompleteTitlePage();
    flushSync();

    exportAs("docx");
    await waitForAdvice();
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();
    expect(document.querySelector(".modal .warn-list")?.textContent).toContain(
      m.titlepage_warn_missing_course(),
    );

    dialogButton(m.export_warn_anyway()).click();
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });
    expect(document.querySelector(".modal")).toBeNull();

    await unmount(component);
  });

  it("resumes the export after the advice is acted on and saved", async () => {
    const component = mountIncompleteTitlePage();
    flushSync();

    exportAs("docx");
    await waitForAdvice();
    dialogButton(m.export_warn_fix()).click();
    flushSync();

    const courseInput = document.querySelector<HTMLInputElement>(
      `input[placeholder="${m.titlepage_course_placeholder()}"]`,
    );
    if (!courseInput) throw new Error("Course input not found");
    courseInput.value = "PSYC 232: Desarrollo humano";
    courseInput.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    // The live list empties as the draft satisfies APA.
    expect(document.querySelector(".modal .warn-list")).toBeNull();

    dialogButton(m.titlepage_save()).click();
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });
    expect(document.querySelector(".modal")).toBeNull();

    await unmount(component);
  });

  it("routes PDF through its own exporter and leaves DOCX untouched", async () => {
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay: exportableEssay(bodyDoc("Seed")),
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    exportAs("pdf");
    await vi.waitFor(() => {
      expect(runtime.exportEssayToPdf).toHaveBeenCalledOnce();
    });
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();

    await unmount(component);
  });

  it("keeps the PDF format through the advice dialog", async () => {
    const component = mountIncompleteTitlePage();
    flushSync();

    exportAs("pdf");
    await waitForAdvice();
    expect(runtime.exportEssayToPdf).not.toHaveBeenCalled();

    // Confirming must honour the format chosen before the advice appeared,
    // not silently fall back to the default.
    dialogButton(m.export_warn_anyway()).click();
    await vi.waitFor(() => {
      expect(runtime.exportEssayToPdf).toHaveBeenCalledOnce();
    });
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();

    await unmount(component);
  });

  it("keeps the PDF format across a fix-the-title-page detour", async () => {
    const component = mountIncompleteTitlePage();
    flushSync();

    exportAs("pdf");
    await waitForAdvice();
    dialogButton(m.export_warn_fix()).click();
    flushSync();

    const courseInput = document.querySelector<HTMLInputElement>(
      `input[placeholder="${m.titlepage_course_placeholder()}"]`,
    );
    if (!courseInput) throw new Error("Course input not found");
    courseInput.value = "PSYC 232: Desarrollo humano";
    courseInput.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();

    dialogButton(m.titlepage_save()).click();
    await vi.waitFor(() => {
      expect(runtime.exportEssayToPdf).toHaveBeenCalledOnce();
    });
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();

    await unmount(component);
  });

  it("abandons the export when the advice is dismissed", async () => {
    const component = mountIncompleteTitlePage();
    flushSync();

    exportAs("docx");
    await waitForAdvice();

    document.querySelector<HTMLButtonElement>(".modal .modal-close")!.click();
    flushSync();
    expect(document.querySelector(".modal")).toBeNull();
    await drainMicrotasks();
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();

    // A later unrelated title-page save must not launch the abandoned export.
    document.querySelector<HTMLButtonElement>("button.out-item")!.click();
    flushSync();
    dialogButton(m.titlepage_save()).click();
    flushSync();
    await drainMicrotasks();
    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();

    await unmount(component);
  });
});

describe("APA export reference integrity", () => {
  it("preserves a newly cited reference deleted during the autosave debounce", async () => {
    vi.useFakeTimers();
    const cited = reference("deleted-before-autosave");
    runtime.libraryReferences = [cited];
    runtime.persist.mockResolvedValue(undefined);
    const essay = exportableEssay(bodyDoc("Seed"));
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    runtime.editors[0]!.commands.setContent(citationDoc(cited.id));
    flushSync();
    runtime.libraryReferences = [];

    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.persist).toHaveBeenCalledOnce();
    const persisted = runtime.persist.mock.calls[0]![0] as Essay;
    expect(persisted.referencesSnapshot).toEqual([cited]);

    exportAs("docx");
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });
    expect(runtime.exportEssayToDocx.mock.calls[0]![2]).toEqual([cited]);

    await unmount(component);
  });

  it("exports a cited snapshot fallback without a missing citation marker", async () => {
    const cited = reference("deleted-ref");
    const essay = exportableEssay(citationDoc(cited.id));
    essay.referencesSnapshot = [cited];

    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    exportAs("docx");
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });

    const [exportedEssay, exportedDocument, exportedReferences] = runtime
      .exportEssayToDocx.mock.calls[0] as [Essay, Content, Reference[]];
    expect(exportedReferences).toEqual([cited]);

    const bytes = await exportDocx({
      content: exportedDocument,
      settings: {
        documentLanguage: exportedEssay.settings.documentLanguage,
        variant: exportedEssay.settings.variant,
        font: exportedEssay.settings.font,
        paperSize: exportedEssay.settings.paperSize,
      },
      titlePage: exportedEssay.titlePage,
      references: exportedReferences,
    });
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
    expect(xml).toContain("Rivera");
    expect(xml).toContain("Evidence-based teaching");
    expect(xml).not.toContain("???");

    await unmount(component);
  });

  it("blocks an unresolved citation before export and shows the localized error", async () => {
    const essay = exportableEssay(citationDoc("gone-for-good"));
    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    exportAs("docx");
    await tick();

    expect(runtime.exportEssayToDocx).not.toHaveBeenCalled();
    expect(document.querySelector(".export-msg")?.textContent).toContain(
      "Este trabajo cita una referencia que ya no está disponible",
    );
    expect(
      m.editor_export_missing_references(undefined, { locale: "en" }),
    ).toContain(
      "This paper cites a reference that is no longer available",
    );
    expect(
      m.editor_export_missing_references(undefined, { locale: "es" }),
    ).toContain(
      "Este trabajo cita una referencia que ya no está disponible",
    );

    await unmount(component);
  });

  it("includes uncited live references once and prefers live cited data", async () => {
    const liveCited = reference("cited-ref", "Current live title");
    const staleSnapshot = reference("cited-ref", "Stale snapshot title");
    const uncited = reference("uncited-ref", "Uncited title");
    runtime.libraryReferences = [uncited, liveCited];
    const essay = exportableEssay(citationDoc(liveCited.id));
    essay.settings.includeUncitedReferences = true;
    essay.referencesSnapshot = [staleSnapshot, liveCited];

    const component = mount(EditorScreen, {
      target: document.body,
      props: {
        essay,
        newlyCreated: false,
        onLaunchConsumed: vi.fn(),
        onBack: vi.fn(),
        onOpenLibrary: vi.fn(),
      },
    });
    flushSync();

    exportAs("docx");
    await vi.waitFor(() => {
      expect(runtime.exportEssayToDocx).toHaveBeenCalledOnce();
    });

    const references = runtime.exportEssayToDocx.mock
      .calls[0]![2] as Reference[];
    expect(references.map((ref) => ref.id).sort()).toEqual([
      "cited-ref",
      "uncited-ref",
    ]);
    expect(references.find((ref) => ref.id === "cited-ref")?.title).toBe(
      "Current live title",
    );

    await unmount(component);
  });
});
