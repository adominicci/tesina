// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { m } from "$lib/paraglide/messages";
import { setLocale } from "$lib/paraglide/runtime";
import { analyzeCoachPassages } from "$lib/learning/coachExperience/analysisAdapter.ts";
import type {
  CoachControllerState,
  CoachPassageSnapshot,
} from "$lib/learning/coachExperience/types.ts";
import WritingCoachStudy from "./WritingCoachStudy.svelte";

const mounted: Array<Record<string, unknown>> = [];
type EmptyCoachStatus = Exclude<CoachControllerState["status"], "issues">;
const EMPTY_COACH_STATES = {
  idle: { status: "idle", issues: [], fixed: null },
  analyzing: { status: "analyzing", issues: [], fixed: null },
  "no-current-issues": {
    status: "no-current-issues",
    issues: [],
    fixed: null,
  },
  "unavailable-for-current-text": {
    status: "unavailable-for-current-text",
    issues: [],
    fixed: null,
  },
} as const satisfies Record<EmptyCoachStatus, CoachControllerState>;
const EMPTY_COACH_STATUSES = [
  "idle",
  "analyzing",
  "no-current-issues",
  "unavailable-for-current-text",
] as const satisfies readonly EmptyCoachStatus[];

function expectedStatusMessage(status: EmptyCoachStatus): string {
  switch (status) {
    case "idle":
      return m.writing_coach_status_idle();
    case "analyzing":
      return m.writing_coach_status_analyzing();
    case "no-current-issues":
      return m.writing_coach_status_no_current();
    case "unavailable-for-current-text":
      return m.writing_coach_status_unavailable();
  }
}

function issueState(
  documentLanguage: "en" | "es" = "en",
  text =
    "It is important to note that the policy changed in many ways during review, and the committee recorded each result.",
): CoachControllerState {
  const passage: CoachPassageSnapshot = {
    kind: "coach-passage-snapshot",
    passageId: "essay-1:1:1",
    essayId: "essay-1",
    revision: 1,
    documentLanguage,
    citationEnvironmentVersion: 0,
    text,
    offsetMap: Array.from({ length: text.length + 1 }, (_, index) => 2 + index),
    protectedSpans: [],
  };
  const analysis = analyzeCoachPassages([passage], 1);
  if (analysis.status !== "available" || analysis.issues.length === 0) {
    throw new Error("expected issue fixture");
  }
  return {
    status: "issues",
    issues: analysis.issues,
    fixed: {
      kind: "fixed-coach-session",
      issue: analysis.issues[0]!,
      position: 1,
      total: analysis.issues.length,
    },
  };
}

function render(
  state: CoachControllerState,
  callbacks: Partial<{
    onPrevious: () => void;
    onNext: () => void;
    onDismiss: () => void;
    onNotHelpful: () => void;
    onEditPassage: () => void;
  }> = {},
  stale = false,
) {
  const component = mount(WritingCoachStudy, {
    target: document.body,
    props: {
      state,
      stale,
      onPrevious: callbacks.onPrevious ?? vi.fn(),
      onNext: callbacks.onNext ?? vi.fn(),
      onDismiss: callbacks.onDismiss ?? vi.fn(),
      onNotHelpful: callbacks.onNotHelpful ?? vi.fn(),
      onEditPassage: callbacks.onEditPassage ?? vi.fn(),
    },
  }) as Record<string, unknown>;
  mounted.push(component);
  return component;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim() === label
  );
  if (!found) throw new Error(`missing button: ${label}`);
  return found;
}

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!);
  document.body.replaceChildren();
  setLocale("es", { reload: false });
});

describe("dedicated Writing Coach Study workspace", () => {
  it("renders a fixed question-led passage without editing or generative controls", () => {
    const state = issueState();
    if (state.status !== "issues") throw new Error("expected issue state");
    const issue = state.fixed.issue;
    render(state);

    expect(document.querySelector("h1")?.textContent).toBe(
      m.writing_coach_title(),
    );
    expect(document.querySelector("[data-coach-count]")?.textContent).toBe(
      m.writing_coach_position({ position: 1, total: state.issues.length }),
    );
    expect(document.querySelector("[data-coach-source]")?.textContent).toBe(
      issue.passage.text,
    );
    expect(document.querySelector("mark")?.textContent).toBe(
      issue.issue.observedText,
    );
    expect(document.querySelector("[data-coach-question]")?.textContent)
      .toContain(issue.issue.observedText);
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(
      /spelling|correction|generated|quiz|model|apply|APA error/i,
    );
  });

  it("offers only deterministic navigation and ephemeral actions", () => {
    const callbacks = {
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onDismiss: vi.fn(),
      onNotHelpful: vi.fn(),
      onEditPassage: vi.fn(),
    };
    const state = issueState();
    render(state, callbacks);
    expect(
      document.querySelector('[role="group"].issue-navigation')
        ?.getAttribute("aria-label"),
    ).toBe(
      m.writing_coach_position({
        position: state.fixed!.position,
        total: state.fixed!.total,
      }),
    );
    button(m.writing_coach_previous()).click();
    button(m.writing_coach_next()).click();
    button(m.writing_coach_dismiss()).click();
    button(m.writing_coach_not_helpful()).click();
    button(m.writing_coach_edit_passage()).click();
    expect(callbacks.onPrevious).toHaveBeenCalledOnce();
    expect(callbacks.onNext).toHaveBeenCalledOnce();
    expect(callbacks.onDismiss).toHaveBeenCalledOnce();
    expect(callbacks.onNotHelpful).toHaveBeenCalledOnce();
    expect(callbacks.onEditPassage).toHaveBeenCalledOnce();
  });

  it("keeps the primary Edit hover high-contrast and distinct from focus", async () => {
    render(issueState());
    expect(button(m.writing_coach_edit_passage()).classList).toContain(
      "primary",
    );
    const css = await readFile(
      fileURLToPath(
        new NodeURL("./WritingCoachStudy.svelte", import.meta.url),
      ),
      "utf8",
    );
    const genericHover = css.indexOf("button:hover:not(:disabled)");
    const primaryHover = css.indexOf("button.primary:hover:not(:disabled)");
    const primaryHoverRule = css.slice(
      primaryHover,
      css.indexOf("}", primaryHover) + 1,
    );
    const focusRule = css.slice(
      css.indexOf("button:focus-visible"),
      css.indexOf("}", css.indexOf("button:focus-visible")) + 1,
    );

    expect(genericHover).toBeGreaterThan(-1);
    expect(primaryHover).toBeGreaterThan(genericHover);
    expect(primaryHoverRule).toContain("background: var(--accent-hover)");
    expect(primaryHoverRule).toContain("color: var(--accent-on)");
    expect(primaryHoverRule).not.toContain("outline");
    expect(focusRule).toContain("outline: 3px solid var(--accent)");
  });

  it("uses one polite announcement, semantic emphasis, and a named stale status", () => {
    render(issueState(), {}, true);
    const liveRegions = document.querySelectorAll(
      '[role="status"][aria-live="polite"]',
    );
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toContain(
      m.writing_coach_status_stale(),
    );
    expect(document.querySelector("mark")?.textContent).not.toBe("");
    expect(document.querySelectorAll("button:not([type='button'])"))
      .toHaveLength(
        0,
      );
  });

  it("keeps long English and Spanish source text within the responsive reduced-motion contract", async () => {
    const passages = [
      issueState(
        "en",
        `${
          "A detailed academic sentence remains readable at narrow widths. "
            .repeat(8)
        } in many ways`,
      ),
      issueState(
        "es",
        `${
          "Una oración académica extensa sigue siendo legible en un espacio estrecho. "
            .repeat(8)
        } de alguna manera`,
      ),
    ];
    for (const state of passages) {
      const component = render(state);
      expect(document.querySelector("[data-coach-source]")?.textContent)
        .toBe(state.fixed?.issue.passage.text);
      await unmount(component);
      mounted.pop();
      document.body.replaceChildren();
    }
    const css = await readFile(
      fileURLToPath(
        new NodeURL("./WritingCoachStudy.svelte", import.meta.url),
      ),
      "utf8",
    );
    const editorCss = await readFile(
      fileURLToPath(new NodeURL("./EditorScreen.svelte", import.meta.url)),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 420px)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("width: 100%");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("scroll-behavior: auto !important");
    expect(css).not.toContain("scroll-behavior: smooth");
    expect(editorCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.canvas[\s\S]*scroll-behavior:\s*auto/,
    );
  });

  it("rerenders all Study chrome in the UI locale without changing the source issue", async () => {
    const state = issueState();
    const fixed = state.fixed;
    const serialized = JSON.stringify(state);
    setLocale("en", { reload: false });
    const englishComponent = render(state);
    const english = {
      category: document.querySelector(".category")?.textContent,
      question: document.querySelector("[data-coach-question]")?.textContent,
      source: document.querySelector("[data-coach-source]")?.textContent,
      actions: [...document.querySelectorAll("button")].map((item) =>
        item.textContent?.trim()
      ),
    };
    await unmount(englishComponent);
    mounted.pop();
    document.body.replaceChildren();

    setLocale("es", { reload: false });
    render(state);
    const spanish = {
      category: document.querySelector(".category")?.textContent,
      question: document.querySelector("[data-coach-question]")?.textContent,
      source: document.querySelector("[data-coach-source]")?.textContent,
      actions: [...document.querySelectorAll("button")].map((item) =>
        item.textContent?.trim()
      ),
    };
    expect(spanish.category).not.toBe(english.category);
    expect(spanish.question).not.toBe(english.question);
    expect(spanish.actions).not.toEqual(english.actions);
    expect(spanish.source).toBe(english.source);
    expect(state.fixed).toBe(fixed);
    expect(JSON.stringify(state)).toBe(serialized);
  });

  it.each(EMPTY_COACH_STATUSES)(
    "renders the %s state distinctly",
    (status) => {
      render(EMPTY_COACH_STATES[status]);
      expect(document.querySelector("[data-coach-state]")?.textContent)
        .toContain(
          expectedStatusMessage(status),
        );
    },
  );
});
