import { describe, expect, it } from "vitest";
import { parseWorkflowYaml, workflowSteps } from "./workflow-policy.ts";

const source = await Deno.readTextFile(
  new URL("../.github/workflows/local-ai-boundary.yml", import.meta.url),
);
const workflow = parseWorkflowYaml(source);
describe("weight-free local inference proof workflow", () => {
  it("uses exact-head native hosts and the shared fake-only runner", () => {
    const steps = workflowSteps(workflow);
    expect(
      steps.some((step) =>
        step.run === "deno run -A scripts/run-local-ai-proof.ts"
      ),
    ).toBe(true);
    expect(source).toContain("macos-latest, windows-latest");
    expect(source).toContain(
      "github.event.pull_request.head.sha || github.sha",
    );
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("contents: read");
    expect(source).not.toMatch(
      /huggingface|llama-server|curl |wget |cargo tauri build|cmake/i,
    );
  });
  it("filters to the native boundary, owners and proof paths", () => {
    expect(source).toContain("paths:");
    expect(source).toContain("apps/desktop/src-tauri/src/local_ai/**");
    expect(source).toContain("scripts/run-local-ai-proof.ts");
    expect(source).not.toContain('"docs/**"');
    expect(source).not.toContain('"apps/desktop/src/**"');
  });
});
