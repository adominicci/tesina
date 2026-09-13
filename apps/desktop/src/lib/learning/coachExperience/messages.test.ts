import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages";
import {
  COACH_CATEGORIES,
  type CoachMessageDescriptor,
  type CoachMessageId,
} from "../coach/types.ts";
import { localizeCoachCategory, localizeCoachDescriptor } from "./messages.ts";

const MESSAGE_IDS = [
  "coach.specificity.explanation",
  "coach.specificity.question",
  "coach.evidence.explanation",
  "coach.evidence.question",
  "coach.clarity.explanation",
  "coach.clarity.question",
  "coach.economy.explanation",
  "coach.economy.question",
  "coach.repetition.explanation",
  "coach.repetition.question",
  "coach.voice.explanation",
  "coach.voice.question",
] as const satisfies readonly CoachMessageId[];

const ALL_MESSAGE_IDS_ARE_LISTED: Exclude<
  CoachMessageId,
  typeof MESSAGE_IDS[number]
> extends never ? true : false = true;

describe("exhaustive writing coach localization", () => {
  it("enumerates exactly six engine categories in English and Spanish", () => {
    expect(COACH_CATEGORIES).toEqual([
      "specificity",
      "evidence",
      "clarity",
      "economy",
      "repetition",
      "voice",
    ]);
    expect(ALL_MESSAGE_IDS_ARE_LISTED).toBe(true);
    for (const locale of ["en", "es"] as const) {
      const labels = COACH_CATEGORIES.map((category) =>
        localizeCoachCategory(category, locale)
      );
      expect(labels).toHaveLength(6);
      expect(new Set(labels).size).toBe(6);
      expect(labels.every((label) => label.length > 0)).toBe(true);
    }
  });

  it("renders every typed descriptor in both UI locales without changing observed text", () => {
    const observedText = "acción ñ";
    for (const locale of ["en", "es"] as const) {
      for (const id of MESSAGE_IDS) {
        const descriptor = {
          id,
          params: { observedText },
        } as CoachMessageDescriptor;
        const rendered = localizeCoachDescriptor(descriptor, locale);
        expect(rendered).toContain(observedText);
        expect(rendered).not.toContain(id);
      }
    }
  });

  it("localizes controls, states, counts, and accessible action names", () => {
    const render = (locale: "en" | "es") => [
      m.writing_coach_mode_write(undefined, { locale }),
      m.writing_coach_mode_study(undefined, { locale }),
      m.writing_coach_status_idle(undefined, { locale }),
      m.writing_coach_status_analyzing(undefined, { locale }),
      m.writing_coach_status_no_current(undefined, { locale }),
      m.writing_coach_status_unavailable(undefined, { locale }),
      m.writing_coach_status_stale(undefined, { locale }),
      m.writing_coach_position({ position: 2, total: 4 }, { locale }),
      m.writing_coach_previous(undefined, { locale }),
      m.writing_coach_next(undefined, { locale }),
      m.writing_coach_dismiss(undefined, { locale }),
      m.writing_coach_not_helpful(undefined, { locale }),
      m.writing_coach_edit_passage(undefined, { locale }),
    ];
    expect(render("en").every((message) => message.length > 0)).toBe(true);
    expect(render("es")).not.toEqual(render("en"));
  });
});
