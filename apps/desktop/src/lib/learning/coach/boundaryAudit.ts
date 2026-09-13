export interface SourceFile {
  path: string;
  source: string;
}

export interface BoundaryFinding {
  path: string;
  token: string;
}

function importSpecifiers(source: string): string[] {
  const imports: string[] = [];
  const pattern =
    /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\))/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) imports.push(specifier);
  }
  return imports;
}

function resolveSourcePath(
  resolved: string,
  paths: ReadonlySet<string>,
): string | null {
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.svelte`,
    `${resolved}/index.ts`,
    `${resolved}/index.tsx`,
    `${resolved}/index.js`,
    `${resolved}/index.svelte`,
  ];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function resolveProductionImport(
  importer: string,
  specifier: string,
  paths: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>>,
): string | null | undefined {
  if (specifier.startsWith(".")) {
    return resolveSourcePath(
      new URL(specifier, `file://${importer}`).pathname,
      paths,
    );
  }
  const alias = Object.entries(aliases).find(([prefix]) =>
    specifier.startsWith(prefix)
  );
  if (!alias) return undefined;
  const [prefix, root] = alias;
  const rootUrl = `file://${root.endsWith("/") ? root : `${root}/`}`;
  return resolveSourcePath(
    new URL(specifier.slice(prefix.length), rootUrl).pathname,
    paths,
  );
}

export function auditProductionImports(
  files: readonly SourceFile[],
  entryPoints: readonly string[],
  forbiddenTokens: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
  leafPaths: ReadonlySet<string> = new Set(),
): BoundaryFinding[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const paths = new Set(byPath.keys());
  const pending = [...entryPoints];
  const visited = new Set<string>();
  const findings: BoundaryFinding[] = [];

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const file = byPath.get(path);
    if (!file) {
      findings.push({ path, token: "unresolved-entry-point" });
      continue;
    }
    for (const token of forbiddenTokens) {
      if (file.source.includes(token)) findings.push({ path, token });
    }
    if (leafPaths.has(path)) continue;
    for (const specifier of importSpecifiers(file.source)) {
      const resolved = resolveProductionImport(
        path,
        specifier,
        paths,
        aliases,
      );
      if (resolved === undefined) continue;
      if (resolved === null) {
        findings.push({ path, token: `unresolved-import:${specifier}` });
      } else {
        pending.push(resolved);
      }
    }
  }

  return findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.token.localeCompare(right.token)
  );
}

const REGISTRATION_PATTERNS = [
  /learning\/coach/u,
  /\banalyzeWriting\b/u,
  /\bauditUnslopV1\b/u,
  /\bwriting_coach\b/u,
] as const;

export function findRuntimeRegistrations(
  files: readonly SourceFile[],
): string[] {
  return files.filter((file) =>
    REGISTRATION_PATTERNS.some((pattern) => pattern.test(file.source))
  ).map((file) => file.path).sort();
}
