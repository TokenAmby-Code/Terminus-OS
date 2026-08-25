// Is this checkout's declared dependency closure actually installed?
//
// A worktree arrives from `gh dispatch` without one. Bun then fails each test
// file at module load — `Cannot find package '@terminus-os/db'` — BEFORE that
// file's `test()` calls have registered, so the file contributes zero tests and
// one error. The run still prints a total, and the total is wrong: the same 128
// files reported 210 tests with the closure absent and 790 with it present.
// 580 tests never existed, and the summary could not say so — 73% of the suite.
//
// That is the failure this guard exists to convert: a partial suite reporting
// as a whole one, in the direction that reads as "my change broke 192 tests".
//
// The check is the same question Bun asks, asked once and early: can each
// declared dependency be resolved from the package that declares it?

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Manifest = {
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readManifest = (directory: string): Manifest | null => {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
};

/**
 * Workspace globs are a trailing `*` or a literal path — the two forms the
 * fleet's manifests use. Anything richer is a manifest this guard should be
 * taught about rather than silently skip, so an unmatched literal is reported
 * as an absent package, not ignored.
 */
const expand = (root: string, pattern: string): string[] => {
  if (!pattern.endsWith("/*")) return [join(root, pattern)];
  const parent = join(root, pattern.slice(0, -2));
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
};

export type MissingDependency = {
  readonly package: string;
  readonly dependency: string;
};

/**
 * Is this dependency installed for the package that declares it?
 *
 * The question is INSTALLED, not importable. `Bun.resolveSync` answers the
 * second and is wrong here twice over: `@types/bun` is types-only and exposes
 * no runtime entry point, and a `workspace:` link resolves through paths that
 * differ by install layout. Both are present on disk and both made the resolve
 * probe report a healthy checkout as broken.
 *
 * Node resolution order is the walk: the nearest `node_modules` up the tree
 * that holds the package wins, which is where bun puts it under either a
 * hoisted or a store-linked layout.
 */
function installed(dependency: string, from: string, root: string): boolean {
  let directory = from;
  for (;;) {
    if (existsSync(join(directory, "node_modules", dependency, "package.json"))) return true;
    if (directory === root) return false;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Every declared dependency that is not installed for the package declaring
 * it. `workspace:` dependencies are included deliberately: bun materializes
 * them as links inside the same install, so their absence is the same absence.
 */
export function missingDependencies(root: string): MissingDependency[] {
  const rootManifest = readManifest(root);
  if (rootManifest === null) return [];
  const directories = [root, ...(rootManifest.workspaces ?? []).flatMap((pattern) => expand(root, pattern))];

  const missing: MissingDependency[] = [];
  for (const directory of directories) {
    const manifest = readManifest(directory);
    if (manifest === null) continue;
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const dependency of Object.keys(declared)) {
      if (!installed(dependency, directory, root)) {
        missing.push({ package: directory.slice(root.length + 1) || ".", dependency });
      }
    }
  }
  return missing;
}

export function closureReport(root: string, missing: readonly MissingDependency[]): string {
  const shown = missing.slice(0, 8)
    .map(({ package: name, dependency }) => `  ${name} declares ${dependency}, which is not installed`);
  const rest = missing.length > shown.length ? [`  ...and ${missing.length - shown.length} more`] : [];
  return [
    `workspace dependency closure is absent in ${root}`,
    ...shown,
    ...rest,
    "",
    "Running the suite now would report a total that is not the suite: files whose",
    "imports cannot resolve fail at module load, before their tests register, so",
    "they contribute an error instead of their test count.",
    "",
    "  bun install --frozen-lockfile",
  ].join("\n");
}
