<script lang="ts">
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { Editor } from "@tiptap/core";
  import type { DocLocale } from "@tesina/engine";
  import type { CitationEnv } from "$lib/editor/citation";
  import { createTesinaEditor } from "$lib/editor/createEditor";
  import type { ReferenceDecorationEnv } from "$lib/editor/referenceDecoration";
  import type { PaginationEnvironment } from "$lib/editor/pagination/types";
  import type { PositionedApaIssue } from "$lib/editor/apaCheck";
  import type { CoachEditorBridge } from "$lib/learning/coachExperience/editorPlugin";
  import "$lib/editor/apa.css";

  interface Props {
    initialDoc?: unknown;
    newlyCreated: boolean;
    documentLanguage?: DocLocale;
    citationEnv: CitationEnv;
    referenceEnv: ReferenceDecorationEnv;
    paginationEnv: PaginationEnvironment | null;
    onUpdate?: (docJson: unknown, words: number) => void;
    onApaIssues?: (issues: PositionedApaIssue[]) => void;
    onReady?: (editor: Editor) => void;
    onLaunchConsumed?: () => void;
    onEditEquation?: (pos: number, latex: string) => void;
    coachBridge?: CoachEditorBridge;
  }

  let {
    initialDoc,
    newlyCreated,
    documentLanguage = "es",
    citationEnv,
    referenceEnv,
    paginationEnv,
    onUpdate,
    onApaIssues,
    onReady,
    onLaunchConsumed,
    onEditEquation,
    coachBridge,
  }: Props = $props();

  const mountEditor: Attachment<HTMLDivElement> = (element) => {
    const editor = untrack(() => {
      const instance = createTesinaEditor({
        element,
        content: initialDoc,
        newlyCreated,
        citationEnv,
        referenceEnv,
        paginationEnv,
        onUpdate,
        onApaIssues,
        onEditEquation,
        coachBridge,
      });
      onReady?.(instance);
      if (newlyCreated) onLaunchConsumed?.();
      return instance;
    });
    return () => untrack(() => editor.destroy());
  };
</script>

<div class="apa-editor" data-doclang={documentLanguage}>
  <div class="page-stack" {@attach mountEditor}></div>
</div>
