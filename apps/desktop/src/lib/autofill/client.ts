import { invoke } from "@tauri-apps/api/core";
import type { Reference } from "@tesina/engine";
import { type CrossrefWork, mapCrossrefWork } from "./crossref.ts";
import { mapOpenLibraryBook, type OpenLibraryBook } from "./openlibrary.ts";
import {
  extractUrlMeta,
  hasUsableMeta,
  urlMetaToReference,
} from "./urlMeta.ts";

export type AutofillError =
  | "offline"
  | "not-found"
  | "unsupported"
  | "parse"
  | "url-unreadable";

export type AutofillResult =
  | { ok: true; ref: Reference }
  | { ok: false; error: AutofillError };

// Citation metadata lives in <head>; anything past this is never useful.
// Enforced while streaming, so a pathological page is never buffered whole.
const MAX_HTML_BYTES = 4_000_000;
/** Destination, headers, redirects and the10s/4MB bounds belong to Rust. */
async function fetchReference(
  url: string,
  kind: "json" | "html",
): Promise<Response> {
  const response = await invoke<{ status: number; body: string }>(
    "reference_fetch",
    { request: { url, kind } },
  );
  // Match the previous transport's null-body statuses; even an empty string
  // otherwise makes Response throw before the existing error mapper runs.
  const body = [204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status });
}

/** Narrow native GET command; no generic HTTP permission is available. */
async function getJson(url: string): Promise<
  { ok: true; body: unknown } | { ok: false; error: AutofillError }
> {
  let res: Response;
  try {
    res = await fetchReference(url, "json");
  } catch {
    return { ok: false, error: "offline" };
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, error: "not-found" };
  }
  if (!res.ok) return { ok: false, error: "offline" };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, error: "parse" };
  }
}

export async function lookupDoi(doi: string): Promise<AutofillResult> {
  const res = await getJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  );
  if (!res.ok) return res;
  const message = (res.body as { message?: CrossrefWork }).message;
  if (!message) return { ok: false, error: "parse" };
  const ref = mapCrossrefWork(message, crypto.randomUUID());
  return ref ? { ok: true, ref } : { ok: false, error: "unsupported" };
}

interface OpenLibraryIsbnResponse extends OpenLibraryBook {
  authors?: { key?: string }[];
}

export async function lookupIsbn(isbn: string): Promise<AutofillResult> {
  const res = await getJson(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!res.ok) return res;
  const data = res.body as OpenLibraryIsbnResponse;

  const names: string[] = [];
  for (const author of (data.authors ?? []).slice(0, 5)) {
    if (!author.key) continue;
    const authorRes = await getJson(
      `https://openlibrary.org${author.key}.json`,
    );
    if (authorRes.ok) {
      const info = authorRes.body as {
        name?: string;
        personal_name?: string;
      };
      const name = info.name ?? info.personal_name;
      if (name) names.push(name);
    }
  }

  const ref = mapOpenLibraryBook(data, names, crypto.randomUUID());
  return ref ? { ok: true, ref } : { ok: false, error: "parse" };
}

/**
 * Reads at most `maxBytes` of a response body, then cancels the rest — the
 * native response has already been bounded before IPC. This decoder preserves
 * the existing metadata reader's UTF-8 behavior, chunk-safely.
 * Exported for tests.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

/**
 * Scrapes a web page for citation metadata. Any failure to read a usable page
 * (network error, blocked/anti-bot response, or a JS-only shell with no real
 * metadata) returns "url-unreadable" so the UI can ask the user to type the
 * reference by hand. When the page exposes a DOI, CrossRef's clean record wins.
 */
export async function lookupUrl(url: string): Promise<AutofillResult> {
  let res: Response;
  try {
    res = await fetchReference(url, "html");
  } catch {
    return { ok: false, error: "url-unreadable" };
  }
  if (!res.ok) return { ok: false, error: "url-unreadable" };

  let html: string;
  try {
    html = await readCapped(res, MAX_HTML_BYTES);
  } catch {
    return { ok: false, error: "url-unreadable" };
  }

  const meta = extractUrlMeta(html);
  if (meta.doi) {
    const byDoi = await lookupDoi(meta.doi);
    if (byDoi.ok) return byDoi;
  }
  if (!hasUsableMeta(meta)) return { ok: false, error: "url-unreadable" };
  return { ok: true, ref: urlMetaToReference(meta, url, crypto.randomUUID()) };
}
