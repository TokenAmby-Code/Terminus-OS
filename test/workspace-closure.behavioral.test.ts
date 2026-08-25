// The guard that stands between a bare worktree and a suite total that lies.
//
// Red-first history, all three observed live on 2026-08-25 in worktrees
// dispatched that day:
//   1. The bare Terminus-OS worktree reports 210 tests / 99 fail across 128
//      files; the same 128 files report 790 / 0 once installed. 73% of the
//      suite was absent. That is what the guard must refuse to let happen
//      quietly. Token-Fleet showed the same defect at 1050 of 2494.
//   2. A `Bun.resolveSync` probe called a HEALTHY checkout broken, because
//      `@types/bun` is types-only and has no runtime entry point.
//   3. The same probe also failed a `workspace:` link that was present on disk.
// Cases 2 and 3 are why `installed()` asks the filesystem, not the resolver.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closureReport, missingDependencies } from "./workspace-closure";

const manifest = (directory: string, body: unknown) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(body));
};

/** A package present on disk with no runtime entry point, like @types/bun. */
const install = (owner: string, name: string) =>
  manifest(join(owner, "node_modules", name), { name });

const fixture = (build: (root: string) => void): string => {
  const root = mkdtempSync(join(tmpdir(), "workspace-closure-"));
  build(root);
  return root;
};

describe("workspace closure detection", () => {
  test("a bare workspace reports every declared dependency as absent", () => {
    const root = fixture((root) => {
      manifest(root, { workspaces: ["shared/one", "shared/two"] });
      manifest(join(root, "shared/one"), { dependencies: { zod: "^4.4.3" } });
      manifest(join(root, "shared/two"), { devDependencies: { typescript: "^5.8.3" } });
    });
    try {
      expect(missingDependencies(root)).toEqual([
        { package: "shared/one", dependency: "zod" },
        { package: "shared/two", dependency: "typescript" },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an installed closure reports nothing", () => {
    const root = fixture((root) => {
      manifest(root, { workspaces: ["shared/one"] });
      const one = join(root, "shared/one");
      manifest(one, { dependencies: { zod: "^4.4.3" } });
      install(one, "zod");
    });
    try {
      expect(missingDependencies(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a types-only package present on disk is installed", () => {
    // The defect this pins: @types/bun exposes no runtime entry point, so a
    // resolver probe called it missing and failed a healthy checkout.
    const root = fixture((root) => {
      manifest(root, { workspaces: ["shared/one"] });
      const one = join(root, "shared/one");
      manifest(one, { devDependencies: { "@types/bun": "1.3.14" } });
      install(one, "@types/bun");
    });
    try {
      expect(missingDependencies(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a dependency hoisted to the workspace root is installed", () => {
    // Bun may place a shared dependency at the root instead of beside its
    // declaring package. Node resolution walks up; so must the guard.
    const root = fixture((root) => {
      manifest(root, { workspaces: ["shared/one"] });
      manifest(join(root, "shared/one"), { dependencies: { zod: "^4.4.3" } });
      install(root, "zod");
    });
    try {
      expect(missingDependencies(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the walk stops at the workspace root", () => {
    // A package installed ABOVE the checkout is not this checkout's closure.
    // Without the root bound the guard would pass on a neighbour's install.
    const root = fixture((root) => {
      manifest(join(root, "inner"), { workspaces: ["one"] });
      manifest(join(root, "inner/one"), { dependencies: { zod: "^4.4.3" } });
      install(root, "zod");
    });
    try {
      expect(missingDependencies(join(root, "inner"))).toEqual([
        { package: "one", dependency: "zod" },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a workspace: dependency is held to the same standard", () => {
    const root = fixture((root) => {
      manifest(root, { workspaces: ["packages/*"] });
      manifest(join(root, "packages/a"), { dependencies: { "@scope/b": "workspace:*" } });
      manifest(join(root, "packages/b"), {});
    });
    try {
      expect(missingDependencies(root)).toEqual([
        { package: "packages/a", dependency: "@scope/b" },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a trailing-star workspace glob expands to its directories", () => {
    const root = fixture((root) => {
      manifest(root, { workspaces: ["packages/*"] });
      manifest(join(root, "packages/a"), { dependencies: { zod: "^4.4.3" } });
      manifest(join(root, "packages/b"), { dependencies: { zod: "^4.4.3" } });
    });
    try {
      expect(missingDependencies(root).map((entry) => entry.package).sort())
        .toEqual(["packages/a", "packages/b"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a checkout with no manifest is not this guard's business", () => {
    const root = fixture(() => {});
    try {
      expect(missingDependencies(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the report names the remedy and does not enumerate without end", () => {
    const missing = Array.from({ length: 22 }, (_, index) => ({
      package: `shared/p${index}`, dependency: "zod",
    }));
    const report = closureReport("/checkout", missing);
    expect(report).toContain("workspace dependency closure is absent in /checkout");
    expect(report).toContain("bun install --frozen-lockfile");
    expect(report).toContain("...and 14 more");
    expect(report.split("\n").filter((line) => line.startsWith("  shared/"))).toHaveLength(8);
  });
});
