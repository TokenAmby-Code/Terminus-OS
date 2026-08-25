// Bun test-lane preload: refuse to run a suite that cannot be the whole suite.
//
// Wired into every `bun test` run by bunfig.toml. Exits rather than throws: a
// throw is attributable to one file, and this is a property of the checkout.

import { closureReport, missingDependencies } from "./workspace-closure";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const missing = missingDependencies(root);
if (missing.length > 0) {
  console.error(closureReport(root, missing));
  process.exit(1);
}
