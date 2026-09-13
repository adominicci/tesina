import { type Editor, Node } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  buildCitationContext,
  type CitationAttrs,
  type CitationContext,
  type DocLocale,
  formatCitation,
  plainText,
  type Reference,
  type RichRun,
} from "@tesina/engine";

/**
 * Everything the citation renderer needs that lives OUTSIDE the document:
 * the library and the document language. The app mutates this object and
 * dispatches a transaction with `setMeta("apa:external", true)` to force a
 * context recompute — one mechanism for library edits, deletions, and
 * language switches alike (plan §4.4).
 */
export interface CitationEnv {
  refsById: ReadonlyMap<string, Reference>;
  locale: DocLocale;
}

interface CitationPluginState {
  ctx: CitationContext;
  /** Document position of the first citation node mentioning each refId. */
  firstOccurrenceAt: ReadonlyMap<string, number>;
  version: number;
  environmentVersion: number;
  environmentKey: string;
}

export const citationPluginKey = new PluginKey<CitationPluginState>(
  "tesinaCitations",
);

export function citationEnvironmentVersion(state: EditorState): number {
  return citationPluginKey.getState(state)?.environmentVersion ?? 0;
}

export function renderCitationText(
  state: EditorState,
  env: CitationEnv,
  node: PMNode,
  position: number,
): string {
  const pluginState = citationPluginKey.getState(state);
  if (!pluginState || node.type.name !== "citation") return "";
  const attrs = node.attrs as CitationAttrs;
  const firstOccurrenceRefIds = new Set(
    attrs.items.map((item) => item.refId).filter((refId) =>
      pluginState.firstOccurrenceAt.get(refId) === position
    ),
  );
  return plainText(formatCitation(
    attrs,
    pluginState.ctx,
    env.refsById,
    env.locale,
    { firstOccurrenceRefIds },
  ));
}

function collectCitations(
  doc: PMNode,
): { attrs: CitationAttrs; pos: number }[] {
  const found: { attrs: CitationAttrs; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "citation") {
      found.push({ attrs: node.attrs as CitationAttrs, pos });
    }
    return true;
  });
  return found;
}

function computeState(
  doc: PMNode,
  env: CitationEnv,
  version: number,
  environmentVersion = 0,
): CitationPluginState {
  const citations = collectCitations(doc);
  const firstOccurrenceAt = new Map<string, number>();
  for (const { attrs, pos } of citations) {
    for (const item of attrs.items) {
      if (!firstOccurrenceAt.has(item.refId)) {
        firstOccurrenceAt.set(item.refId, pos);
      }
    }
  }
  const ctx = buildCitationContext(
    citations.map((c) => c.attrs),
    env.refsById,
    env.locale,
  );
  return {
    ctx,
    firstOccurrenceAt,
    version,
    environmentVersion,
    environmentKey: JSON.stringify(citations.map(({ attrs }) => attrs)),
  };
}

function renderRuns(target: HTMLElement, runs: RichRun[]): void {
  target.replaceChildren(
    ...runs.map((run) => {
      if (run.italic) {
        const em = document.createElement("em");
        em.textContent = run.text;
        return em;
      }
      return document.createTextNode(run.text);
    }),
  );
}

/**
 * Inline atomic citation node. Only `CitationAttrs` are persisted; the
 * visible text is a pure function of (attrs, library, locale, context) and
 * re-renders on every transaction — cheap at essay scale, and it makes
 * library edits and language flips retranslate every chip in place.
 */
export function createCitationExtension(env: CitationEnv) {
  return Node.create({
    name: "citation",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        items: { default: [] },
        mode: { default: "parenthetical" },
      };
    },

    parseHTML() {
      return [
        {
          tag: "span[data-citation]",
          getAttrs: (el) => {
            try {
              return JSON.parse(
                (el as HTMLElement).dataset["citation"] ?? "",
              ) as CitationAttrs;
            } catch {
              return false;
            }
          },
        },
      ];
    },

    renderHTML({ node }) {
      const attrs = node.attrs as CitationAttrs;
      return [
        "span",
        {
          "data-citation": JSON.stringify(attrs),
          class: "tesina-citation",
        },
        attrs.mode === "narrative" ? "[cita narrativa]" : "[cita]",
      ];
    },

    addProseMirrorPlugins() {
      return [
        new Plugin<CitationPluginState>({
          key: citationPluginKey,
          state: {
            init: (_config, state) => computeState(state.doc, env, 0),
            apply: (tr, prev) => {
              if (!tr.docChanged && !tr.getMeta("apa:external")) return prev;
              const next = computeState(
                tr.doc,
                env,
                prev.version + 1,
                prev.environmentVersion,
              );
              return {
                ...next,
                environmentVersion: tr.getMeta("apa:external") ||
                    next.environmentKey !== prev.environmentKey
                  ? prev.environmentVersion + 1
                  : prev.environmentVersion,
              };
            },
          },
        }),
      ];
    },

    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node;
        const dom = document.createElement("span");
        dom.className = "tesina-citation";
        let renderedVersion = -1;

        const render = (force = false) => {
          const pluginState = citationPluginKey.getState(editor.state);
          if (!pluginState) return;
          if (!force && pluginState.version === renderedVersion) return;
          renderedVersion = pluginState.version;
          const attrs = current.attrs as CitationAttrs;
          const pos = typeof getPos === "function" ? getPos() : undefined;
          const firstOccurrenceRefIds = new Set(
            attrs.items
              .map((item) => item.refId)
              .filter(
                (refId) => pluginState.firstOccurrenceAt.get(refId) === pos,
              ),
          );
          const runs = formatCitation(
            attrs,
            pluginState.ctx,
            env.refsById,
            env.locale,
            { firstOccurrenceRefIds },
          );
          renderRuns(dom, runs);
          dom.title = plainText(runs);
          dom.classList.toggle(
            "tesina-citation--missing",
            attrs.items.some((item) => !env.refsById.has(item.refId)),
          );
        };

        const onTransaction = () => render();
        editor.on("transaction", onTransaction);
        render(true);

        return {
          dom,
          update: (updated) => {
            if (updated.type.name !== "citation") return false;
            current = updated;
            render(true);
            return true;
          },
          destroy: () => {
            editor.off("transaction", onTransaction);
          },
        };
      };
    },
  });
}

export function insertCitation(editor: Editor, attrs: CitationAttrs): void {
  editor
    .chain()
    .focus()
    .insertContent([{ type: "citation", attrs }, { type: "text", text: " " }])
    .run();
}

/** Force chips to recompute after library or document-language changes. */
export function refreshCitations(editor: Editor): void {
  const tr = editor.state.tr.setMeta("apa:external", true);
  editor.view.dispatch(tr);
}
