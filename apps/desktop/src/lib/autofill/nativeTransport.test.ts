// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
import { lookupDoi, lookupIsbn, lookupUrl } from "./client.ts";

describe("bounded native reference transport", () => {
  beforeEach(() => native.mockReset());
  it("preserves parse failures for empty successful DOI and ISBN responses", async () => {
    for (const status of [204, 205]) {
      native.mockResolvedValueOnce({ status, body: "" });
      expect(await lookupDoi("10.1234/example")).toEqual({
        ok: false,
        error: "parse",
      });
      native.mockResolvedValueOnce({ status, body: "" });
      expect(await lookupIsbn("9780000000000")).toEqual({
        ok: false,
        error: "parse",
      });
    }
  });
  it("keeps DOI metadata preference for a public page", async () => {
    native.mockResolvedValueOnce({
      status: 200,
      body:
        '<meta name="citation_title" content="Page title"><meta name="citation_doi" content="10.1234/example">',
    });
    native.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        message: {
          type: "journal-article",
          title: ["Canonical title"],
          "container-title": ["Journal"],
          DOI: "10.1234/example",
        },
      }),
    });
    expect(await lookupUrl("https://example.org/paper")).toMatchObject({
      ok: true,
      ref: { title: "Canonical title", doi: "10.1234/example" },
    });
    expect(native.mock.calls).toEqual([
      ["reference_fetch", {
        request: { url: "https://example.org/paper", kind: "html" },
      }],
      ["reference_fetch", {
        request: {
          url: "https://api.crossref.org/works/10.1234%2Fexample",
          kind: "json",
        },
      }],
    ]);
  });
  it("preserves ISBN author enrichment", async () => {
    native.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        title: "Fixture book",
        publishers: ["Publisher"],
        publish_date: "2020",
        authors: [{ key: "/authors/A1" }],
      }),
    });
    native.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ name: "Ana Rivera" }),
    });
    expect(await lookupIsbn("9780000000000")).toMatchObject({
      ok: true,
      ref: {
        title: "Fixture book",
        authors: [{ family: "Rivera", given: "Ana" }],
      },
    });
    expect(native).toHaveBeenLastCalledWith("reference_fetch", {
      request: { url: "https://openlibrary.org/authors/A1.json", kind: "json" },
    });
  });
  it("keeps public HTTP HTML metadata when DOI lookup is unavailable", async () => {
    native.mockResolvedValueOnce({
      status: 200,
      body:
        '<meta name="citation_title" content="Árbol &amp; tierra"><meta name="citation_author" content="Rivera, Ana"><meta name="citation_date" content="2020-03-04"><meta name="citation_doi" content="10.1234/fallback">',
    });
    native.mockRejectedValueOnce("unreadable");
    expect(await lookupUrl("http://example.org/legacy")).toMatchObject({
      ok: true,
      ref: {
        title: "Árbol & tierra",
        url: "http://example.org/legacy",
        authors: [{ family: "Rivera", given: "Ana" }],
      },
    });
    expect(native).toHaveBeenNthCalledWith(1, "reference_fetch", {
      request: { url: "http://example.org/legacy", kind: "html" },
    });
  });
  it("retains the existing five-author request limit", async () => {
    native.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        title: "Fixture book",
        publishers: ["Publisher"],
        publish_date: "2020",
        authors: Array.from(
          { length: 6 },
          (_, i) => ({ key: `/authors/A${i}` }),
        ),
      }),
    });
    native.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ name: "Ana Rivera" }),
    });
    expect(await lookupIsbn("9780000000000")).toMatchObject({ ok: true });
    expect(native).toHaveBeenCalledTimes(6);
    expect(native).toHaveBeenLastCalledWith("reference_fetch", {
      request: { url: "https://openlibrary.org/authors/A4.json", kind: "json" },
    });
  });
  it("keeps existing offline/not-found/parse and private URL failure categories", async () => {
    native.mockRejectedValueOnce("unreadable");
    expect(await lookupDoi("10.1234/example")).toEqual({
      ok: false,
      error: "offline",
    });
    native.mockResolvedValueOnce({ status: 404, body: "" });
    expect(await lookupDoi("10.1234/example")).toEqual({
      ok: false,
      error: "not-found",
    });
    native.mockResolvedValueOnce({ status: 200, body: "{" });
    expect(await lookupDoi("10.1234/example")).toEqual({
      ok: false,
      error: "parse",
    });
    native.mockRejectedValueOnce("invalid-request");
    expect(await lookupUrl("http://127.0.0.1/private")).toEqual({
      ok: false,
      error: "url-unreadable",
    });
  });
});
