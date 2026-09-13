import { describe, expect, it } from "vitest";
import { parseNativeManualInputMessage } from "./nativeManualInputProtocol.ts";

describe("native manual-input protocol", () => {
  it("validates the collapsed selection before requesting native paste", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "collapsed",
      documentSize: 500,
      selectionPos: 75,
    })).toEqual({
      version: 1,
      stage: "collapsed",
      documentSize: 500,
      selectionPos: 75,
    });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "collapsed",
        documentSize: 500,
        selectionPos: 501,
      })
    ).toThrow();
  });

  it("accepts finite viewport geometry that visibly straddles the gap", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "ready",
      viewport: { width: 1200, height: 900 },
      devicePixelRatio: 1.25,
      gap: { top: 320, bottom: 500 },
      dragStart: { x: 260, y: 300 },
      dragEnd: { x: 520, y: 520 },
    })).toEqual({
      version: 1,
      stage: "ready",
      viewport: { width: 1200, height: 900 },
      devicePixelRatio: 1.25,
      gap: { top: 320, bottom: 500 },
      dragStart: { x: 260, y: 300 },
      dragEnd: { x: 520, y: 520 },
    });
  });

  it.each([
    ["zero device scale", { devicePixelRatio: 0 }],
    ["non-finite point", { dragStart: { x: Number.NaN, y: 300 } }],
    ["off-viewport point", { dragEnd: { x: 1_201, y: 520 } }],
    ["same-side points", { dragEnd: { x: 520, y: 310 } }],
  ])("rejects %s", (_label, replacement) => {
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "ready",
        viewport: { width: 1200, height: 900 },
        devicePixelRatio: 1.25,
        gap: { top: 320, bottom: 500 },
        dragStart: { x: 260, y: 300 },
        dragEnd: { x: 520, y: 520 },
        ...replacement,
      })
    ).toThrow();
  });

  it("accepts only nonempty drag evidence that crosses the PM gap", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "drag",
      selectionFrom: 42,
      selectionTo: 75,
      gapPosition: 60,
      selectedText: "invented selection",
    })).toMatchObject({ stage: "drag", gapPosition: 60 });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "drag",
        selectionFrom: 61,
        selectionTo: 75,
        gapPosition: 60,
        selectedText: "invented selection",
      })
    ).toThrow();
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "drag",
        selectionFrom: 42,
        selectionTo: 75,
        gapPosition: 60,
        selectedText: "",
      })
    ).toThrow();
  });

  it("requires exact clipboard text and authored paste growth", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "copy",
      selectedText: "invented selection",
      documentSize: 500,
    })).toMatchObject({ stage: "copy", documentSize: 500 });
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "paste",
      pastedText: "invented selection",
      beforeSize: 500,
      afterSize: 518,
      selectionPos: 317,
    })).toMatchObject({
      stage: "paste",
      afterSize: 518,
      selectionPos: 317,
    });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "paste",
        pastedText: "invented selection",
        beforeSize: 500,
        afterSize: 500,
        selectionPos: 317,
      })
    ).toThrow();
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "paste",
        pastedText: "invented selection",
        beforeSize: 500,
        afterSize: 518,
      })
    ).toThrow();
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "paste",
        pastedText: "invented selection",
        beforeSize: 500,
        afterSize: 518,
        selectionPos: 519,
      })
    ).toThrow();
  });

  it("requires an exact unchanged-document caret acknowledgement", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "caret",
      documentSize: 518,
      beforePos: 317,
      afterPos: 318,
    })).toEqual({
      version: 1,
      stage: "caret",
      documentSize: 518,
      beforePos: 317,
      afterPos: 318,
    });
    for (
      const invalid of [
        { documentSize: 518, beforePos: 317, afterPos: 317 },
        { documentSize: 518, beforePos: 317, afterPos: 319 },
        { documentSize: 518, beforePos: 518, afterPos: 519 },
      ]
    ) {
      expect(() =>
        parseNativeManualInputMessage({
          version: 1,
          stage: "caret",
          ...invalid,
        })
      ).toThrow();
    }
  });

  it("accepts only the audited dead-key character with its exact insertion position", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "dead-key",
      data: "é",
      beforeSize: 518,
      afterSize: 519,
      insertionPos: 317,
    })).toMatchObject({ stage: "dead-key", data: "é", insertionPos: 317 });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "dead-key",
        data: "e",
        beforeSize: 518,
        afterSize: 519,
        insertionPos: 317,
      })
    ).toThrow();
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "dead-key",
        data: "é",
        beforeSize: 518,
        afterSize: 518,
        insertionPos: 317,
      })
    ).toThrow();
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "dead-key",
        data: "é",
        beforeSize: 518,
        afterSize: 519,
        insertionPos: 519,
      })
    ).toThrow();
  });

  it("acknowledges the trusted dead-key keydown before the authored character", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "dead-keydown",
      documentSize: 518,
      insertionPos: 318,
    })).toEqual({
      version: 1,
      stage: "dead-keydown",
      documentSize: 518,
      insertionPos: 318,
    });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "dead-keydown",
        documentSize: 518,
        insertionPos: 519,
      })
    ).toThrow();
  });

  it("requires explicit document and selection identity after one native undo", () => {
    expect(parseNativeManualInputMessage({
      version: 1,
      stage: "undo",
      documentSize: 518,
      documentRestored: true,
      selectionRestored: true,
    })).toEqual({
      version: 1,
      stage: "undo",
      documentSize: 518,
      documentRestored: true,
      selectionRestored: true,
    });
    expect(() =>
      parseNativeManualInputMessage({
        version: 1,
        stage: "undo",
        documentSize: 518,
        documentRestored: "yes",
        selectionRestored: true,
      })
    ).toThrow();
  });
});
