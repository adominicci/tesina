export interface NativeInputPoint {
  x: number;
  y: number;
}

export const NATIVE_INPUT_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_NATIVE_INPUT_DRIVER = "win32-sendinput-v1" as const;

export interface NativeInputViewport {
  width: number;
  height: number;
}

export interface NativeInputGapBounds {
  top: number;
  bottom: number;
}

export type NativeManualInputMessage =
  | {
    version: 1;
    stage: "collapsed";
    documentSize: number;
    selectionPos: number;
  }
  | {
    version: 1;
    stage: "ready";
    viewport: NativeInputViewport;
    devicePixelRatio: number;
    gap: NativeInputGapBounds;
    dragStart: NativeInputPoint;
    dragEnd: NativeInputPoint;
  }
  | {
    version: 1;
    stage: "drag";
    selectionFrom: number;
    selectionTo: number;
    gapPosition: number;
    selectedText: string;
  }
  | {
    version: 1;
    stage: "copy";
    selectedText: string;
    documentSize: number;
  }
  | {
    version: 1;
    stage: "paste";
    pastedText: string;
    beforeSize: number;
    afterSize: number;
    selectionPos: number;
  }
  | {
    version: 1;
    stage: "caret";
    documentSize: number;
    beforePos: number;
    afterPos: number;
  }
  | {
    version: 1;
    stage: "dead-keydown";
    documentSize: number;
    insertionPos: number;
  }
  | {
    version: 1;
    stage: "dead-key";
    data: "é";
    beforeSize: number;
    afterSize: number;
    insertionPos: number;
  }
  | {
    version: 1;
    stage: "undo";
    documentSize: number;
    documentRestored: boolean;
    selectionRestored: boolean;
  };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function documentPosition(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function nonemptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be nonempty`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function point(value: unknown, label: string): NativeInputPoint {
  const parsed = record(value, label);
  return {
    x: finiteNumber(parsed["x"], `${label}.x`),
    y: finiteNumber(parsed["y"], `${label}.y`),
  };
}

function insideViewport(
  pointValue: NativeInputPoint,
  viewport: NativeInputViewport,
  label: string,
): void {
  if (
    pointValue.x < 0 || pointValue.x >= viewport.width ||
    pointValue.y < 0 || pointValue.y >= viewport.height
  ) {
    throw new Error(`${label} must be inside the viewport`);
  }
}

export function parseNativeManualInputMessage(
  value: unknown,
): NativeManualInputMessage {
  const message = record(value, "native input message");
  if (message["version"] !== 1) {
    throw new Error("native input message version must be 1");
  }
  switch (message["stage"]) {
    case "ready": {
      const viewportValue = record(message["viewport"], "viewport");
      const viewport = {
        width: positiveNumber(viewportValue["width"], "viewport.width"),
        height: positiveNumber(viewportValue["height"], "viewport.height"),
      };
      const gapValue = record(message["gap"], "gap");
      const gap = {
        top: finiteNumber(gapValue["top"], "gap.top"),
        bottom: finiteNumber(gapValue["bottom"], "gap.bottom"),
      };
      if (
        gap.top < 0 || gap.bottom <= gap.top || gap.bottom >= viewport.height
      ) {
        throw new Error("gap must be ordered inside the viewport");
      }
      const dragStart = point(message["dragStart"], "dragStart");
      const dragEnd = point(message["dragEnd"], "dragEnd");
      insideViewport(dragStart, viewport, "dragStart");
      insideViewport(dragEnd, viewport, "dragEnd");
      if (dragStart.y >= gap.top || dragEnd.y <= gap.bottom) {
        throw new Error("drag points must straddle the gap");
      }
      return {
        version: 1,
        stage: "ready",
        viewport,
        devicePixelRatio: positiveNumber(
          message["devicePixelRatio"],
          "devicePixelRatio",
        ),
        gap,
        dragStart,
        dragEnd,
      };
    }
    case "drag": {
      const selectionFrom = documentPosition(
        message["selectionFrom"],
        "selectionFrom",
      );
      const selectionTo = documentPosition(
        message["selectionTo"],
        "selectionTo",
      );
      const gapPosition = documentPosition(
        message["gapPosition"],
        "gapPosition",
      );
      if (!(selectionFrom < gapPosition && gapPosition < selectionTo)) {
        throw new Error("selection must cross the pagination gap");
      }
      return {
        version: 1,
        stage: "drag",
        selectionFrom,
        selectionTo,
        gapPosition,
        selectedText: nonemptyText(message["selectedText"], "selectedText"),
      };
    }
    case "copy":
      return {
        version: 1,
        stage: "copy",
        selectedText: nonemptyText(message["selectedText"], "selectedText"),
        documentSize: documentPosition(message["documentSize"], "documentSize"),
      };
    case "collapsed": {
      const documentSize = documentPosition(
        message["documentSize"],
        "documentSize",
      );
      const selectionPos = documentPosition(
        message["selectionPos"],
        "selectionPos",
      );
      if (selectionPos > documentSize) {
        throw new Error("collapsed selection must be inside the document");
      }
      return { version: 1, stage: "collapsed", documentSize, selectionPos };
    }
    case "paste": {
      const pastedText = nonemptyText(message["pastedText"], "pastedText");
      const beforeSize = documentPosition(message["beforeSize"], "beforeSize");
      const afterSize = documentPosition(message["afterSize"], "afterSize");
      const selectionPos = documentPosition(
        message["selectionPos"],
        "selectionPos",
      );
      if (afterSize - beforeSize !== pastedText.length) {
        throw new Error(
          "paste must grow the document by the clipboard text length",
        );
      }
      if (selectionPos > afterSize) {
        throw new Error("paste selection must be inside the authored document");
      }
      return {
        version: 1,
        stage: "paste",
        pastedText,
        beforeSize,
        afterSize,
        selectionPos,
      };
    }
    case "caret": {
      const documentSize = documentPosition(
        message["documentSize"],
        "documentSize",
      );
      const beforePos = documentPosition(message["beforePos"], "beforePos");
      const afterPos = documentPosition(message["afterPos"], "afterPos");
      if (afterPos !== beforePos + 1 || afterPos > documentSize) {
        throw new Error(
          "caret acknowledgement must advance exactly one authored position",
        );
      }
      return {
        version: 1,
        stage: "caret",
        documentSize,
        beforePos,
        afterPos,
      };
    }
    case "dead-keydown": {
      const documentSize = documentPosition(
        message["documentSize"],
        "documentSize",
      );
      const insertionPos = documentPosition(
        message["insertionPos"],
        "insertionPos",
      );
      if (insertionPos > documentSize) {
        throw new Error(
          "dead-key insertion must be inside the authored document",
        );
      }
      return {
        version: 1,
        stage: "dead-keydown",
        documentSize,
        insertionPos,
      };
    }
    case "dead-key": {
      if (message["data"] !== "é") {
        throw new Error("dead-key data must be the audited NFC character");
      }
      const beforeSize = documentPosition(message["beforeSize"], "beforeSize");
      const afterSize = documentPosition(message["afterSize"], "afterSize");
      const insertionPos = documentPosition(
        message["insertionPos"],
        "insertionPos",
      );
      if (afterSize - beforeSize !== 1) {
        throw new Error(
          "dead-key input must add exactly one authored character",
        );
      }
      if (insertionPos > beforeSize) {
        throw new Error(
          "dead-key insertion must be inside the authored document",
        );
      }
      return {
        version: 1,
        stage: "dead-key",
        data: "é",
        beforeSize,
        afterSize,
        insertionPos,
      };
    }
    case "undo":
      return {
        version: 1,
        stage: "undo",
        documentSize: documentPosition(
          message["documentSize"],
          "documentSize",
        ),
        documentRestored: booleanValue(
          message["documentRestored"],
          "documentRestored",
        ),
        selectionRestored: booleanValue(
          message["selectionRestored"],
          "selectionRestored",
        ),
      };
    default:
      throw new Error("unknown native input message stage");
  }
}
