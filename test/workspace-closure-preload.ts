// Bun test-lane preload: refuse to run a suite that cannot be the whole suite.
//
// Wired into every `bun test` run by bunfig.toml. Exits rather than throws: a
// throw is attributable to one file, and this is a property of the checkout.
//
// The guard lives in @tokenamby-code/stc-contract. The preload cannot import
// it until it has proved that package is installed — an absent import at
// preload time is exactly the partial total the guard exists to refuse — so it
// asks the filesystem first, then imports.

import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
if (!existsSync(`${root}/node_modules/@tokenamby-code/stc-contract/package.json`)) {
  console.error(`@tokenamby-code/stc-contract is not installed in ${root}; bun install --frozen-lockfile`);
  process.exit(1);
}
const { closureReport, missingDependencies } = await import("@tokenamby-code/stc-contract/workspace-closure");
const missing = missingDependencies(root);
if (missing.length > 0) {
  console.error(closureReport(root, missing));
  process.exit(1);
}
