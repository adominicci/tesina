<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import {
    localizeCoachCategory,
    localizeCoachDescriptor,
  } from "$lib/learning/coachExperience/messages.ts";
  import type { CoachControllerState } from "$lib/learning/coachExperience/types.ts";

  interface Props {
    state: CoachControllerState;
    stale?: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onDismiss: () => void;
    onNotHelpful: () => void;
    onEditPassage: () => void;
    onHeadingReady?: (element: HTMLHeadingElement | null) => void;
  }

  let {
    state,
    stale = false,
    onPrevious,
    onNext,
    onDismiss,
    onNotHelpful,
    onEditPassage,
    onHeadingReady,
  }: Props = $props();

  let fixed = $derived(state.fixed);
  let mapped = $derived(fixed?.issue ?? null);
  let sourceBefore = $derived(
    mapped?.passage.text.slice(0, mapped.issue.from) ?? "",
  );
  let sourceIssue = $derived(
    mapped?.passage.text.slice(mapped.issue.from, mapped.issue.to) ?? "",
  );
  let sourceAfter = $derived(
    mapped?.passage.text.slice(mapped.issue.to) ?? "",
  );

  function stateMessage(): string {
    if (stale) return m.writing_coach_status_stale();
    switch (state.status) {
      case "idle":
        return m.writing_coach_status_idle();
      case "analyzing":
        return m.writing_coach_status_analyzing();
      case "no-current-issues":
        return m.writing_coach_status_no_current();
      case "unavailable-for-current-text":
        return m.writing_coach_status_unavailable();
      case "issues":
        return m.writing_coach_position({
          position: state.fixed.position,
          total: state.fixed.total,
        });
    }
  }
</script>

<section class="study" data-coach-workspace aria-labelledby="writing-coach-heading">
  <header class="study-header">
    <div>
      <p class="eyebrow">{m.writing_coach_mode_study()}</p>
      <h1
        id="writing-coach-heading"
        tabindex="-1"
        {@attach (element) => {
          onHeadingReady?.(element);
          return () => onHeadingReady?.(null);
        }}
      >{m.writing_coach_title()}</h1>
    </div>
    <p class="intro">{m.writing_coach_intro()}</p>
  </header>

  <div class="live-region sr-only" role="status" aria-live="polite" aria-atomic="true">
    {stateMessage()}
  </div>

  {#if mapped && fixed}
    <article class="observation">
      <div class="observation-meta">
        <span class="category">{localizeCoachCategory(mapped.issue.category)}</span>
        <span data-coach-count>{m.writing_coach_position({
          position: fixed.position,
          total: fixed.total,
        })}</span>
      </div>

      <section class="source-card" aria-labelledby="coach-source-heading">
        <h2 id="coach-source-heading">{m.writing_coach_source_label()}</h2>
        <p data-coach-source>{sourceBefore}<mark>{sourceIssue}</mark>{sourceAfter}</p>
      </section>

      <section class="reflection" aria-labelledby="coach-notice-heading">
        <h2 id="coach-notice-heading">{m.writing_coach_explanation_label()}</h2>
        <p>{localizeCoachDescriptor(mapped.issue.explanation)}</p>
        <h2>{m.writing_coach_question_label()}</h2>
        <p class="question" data-coach-question>
          {localizeCoachDescriptor(mapped.issue.learningQuestion)}
        </p>
      </section>

      <div class="issue-navigation" role="group" aria-label={m.writing_coach_position({
        position: fixed.position,
        total: fixed.total,
      })}>
        <button type="button" onclick={onPrevious} disabled={fixed.total < 2}>
          {m.writing_coach_previous()}
        </button>
        <button type="button" onclick={onNext} disabled={fixed.total < 2}>
          {m.writing_coach_next()}
        </button>
      </div>

      <div class="actions">
        <button type="button" class="quiet" onclick={onDismiss}>
          {m.writing_coach_dismiss()}
        </button>
        <button type="button" class="quiet" onclick={onNotHelpful}>
          {m.writing_coach_not_helpful()}
        </button>
        <button type="button" class="primary" onclick={onEditPassage}>
          {m.writing_coach_edit_passage()}
        </button>
      </div>
    </article>
  {:else}
    <div class="state-card" data-coach-state data-state={state.status}>
      <span class="state-symbol" aria-hidden="true">{state.status === "analyzing" ? "⋯" : "○"}</span>
      <p>{stateMessage()}</p>
    </div>
  {/if}
</section>

<style>
  .study {
    box-sizing: border-box;
    width: min(100%, 760px);
    margin: 0 auto;
    padding: clamp(24px, 5vw, 64px) clamp(16px, 4vw, 48px);
    color: var(--fg);
  }
  .study-header {
    display: grid;
    gap: 12px;
    margin-bottom: 28px;
  }
  .eyebrow {
    margin: 0 0 6px;
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  h1, h2, p { margin-top: 0; }
  h1 { margin-bottom: 0; font-size: clamp(1.75rem, 5vw, 2.5rem); }
  h1:focus-visible { outline: 3px solid var(--accent); outline-offset: 6px; }
  h2 { margin-bottom: 10px; font-size: 0.82rem; letter-spacing: 0.04em; text-transform: uppercase; }
  .intro { max-width: 58ch; margin-bottom: 0; color: var(--muted); line-height: 1.55; }
  .observation { display: grid; gap: 18px; }
  .observation-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; color: var(--muted); font-size: 0.82rem; }
  .category { border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px; color: var(--fg); font-weight: 650; }
  .source-card, .reflection, .state-card { box-sizing: border-box; border: 1px solid var(--border); border-radius: 14px; background: var(--chrome); padding: clamp(18px, 4vw, 28px); }
  .source-card p { margin-bottom: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; }
  mark { border-bottom: 3px solid currentColor; background: color-mix(in srgb, var(--accent) 18%, transparent); color: inherit; font-weight: 650; }
  .reflection p:last-child { margin-bottom: 0; }
  .question { font-size: 1.08rem; font-weight: 600; line-height: 1.55; }
  .issue-navigation, .actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .actions { padding-top: 4px; }
  button { min-height: 40px; max-width: 100%; border: 1px solid var(--border); border-radius: 9px; background: transparent; color: inherit; padding: 9px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--hover); }
  button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: 0.45; }
  button.primary { margin-left: auto; border-color: var(--accent); background: var(--accent); color: var(--accent-on); }
  button.primary:hover:not(:disabled) { border-color: var(--accent-hover); background: var(--accent-hover); color: var(--accent-on); }
  .state-card { display: flex; align-items: center; gap: 14px; min-height: 120px; }
  .state-card p { margin-bottom: 0; }
  .state-symbol { display: grid; width: 30px; height: 30px; flex: 0 0 auto; place-items: center; border: 2px solid currentColor; border-radius: 50%; font-weight: 800; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 420px) {
    .study { padding-inline: 12px; }
    .actions > button { width: 100%; }
    button.primary { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .study, .study * { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
  }
</style>
