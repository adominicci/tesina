import { m } from "$lib/paraglide/messages";
import type { CoachCategory, CoachMessageDescriptor } from "../coach/types.ts";

export type CoachUiLocale = "en" | "es";

function localeOptions(locale?: CoachUiLocale) {
  return locale ? { locale } : undefined;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported writing coach message: ${String(value)}`);
}

export function localizeCoachCategory(
  category: CoachCategory,
  locale?: CoachUiLocale,
): string {
  const options = localeOptions(locale);
  switch (category) {
    case "specificity":
      return m.writing_coach_category_specificity(undefined, options);
    case "evidence":
      return m.writing_coach_category_evidence(undefined, options);
    case "clarity":
      return m.writing_coach_category_clarity(undefined, options);
    case "economy":
      return m.writing_coach_category_economy(undefined, options);
    case "repetition":
      return m.writing_coach_category_repetition(undefined, options);
    case "voice":
      return m.writing_coach_category_voice(undefined, options);
    default:
      return assertNever(category);
  }
}

export function localizeCoachDescriptor(
  descriptor: CoachMessageDescriptor,
  locale?: CoachUiLocale,
): string {
  const options = localeOptions(locale);
  switch (descriptor.id) {
    case "coach.specificity.explanation":
      return m.writing_coach_specificity_explanation(
        descriptor.params,
        options,
      );
    case "coach.specificity.question":
      return m.writing_coach_specificity_question(descriptor.params, options);
    case "coach.evidence.explanation":
      return m.writing_coach_evidence_explanation(descriptor.params, options);
    case "coach.evidence.question":
      return m.writing_coach_evidence_question(descriptor.params, options);
    case "coach.clarity.explanation":
      return m.writing_coach_clarity_explanation(descriptor.params, options);
    case "coach.clarity.question":
      return m.writing_coach_clarity_question(descriptor.params, options);
    case "coach.economy.explanation":
      return m.writing_coach_economy_explanation(descriptor.params, options);
    case "coach.economy.question":
      return m.writing_coach_economy_question(descriptor.params, options);
    case "coach.repetition.explanation":
      return m.writing_coach_repetition_explanation(
        descriptor.params,
        options,
      );
    case "coach.repetition.question":
      return m.writing_coach_repetition_question(descriptor.params, options);
    case "coach.voice.explanation":
      return m.writing_coach_voice_explanation(descriptor.params, options);
    case "coach.voice.question":
      return m.writing_coach_voice_question(descriptor.params, options);
    default:
      return assertNever(descriptor);
  }
}
