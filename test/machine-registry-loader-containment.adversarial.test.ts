// The Token-Fleet machine-registry loader stays excised.
//
// packages/contracts/src/machine-config.ts advertised a public API for reading
// Token-Fleet's generated registry. It was dead and wrong at the same time,
// which is worse than either alone: the package exported it, so it read as
// supported, and the next author to reach for it would have got a runtime
// failure from something the package promised.
//
// Dead: no caller in either repository. Its only consumer was its own test,
// and the env var it defaulted to — TOKEN_FLEET_MACHINE_REGISTRY — was set
// nowhere on the fleet, so the zero-argument path threw unconditionally.
//
// Wrong: the schema was a z.strictObject requiring a top-level
// serviceAuthorities key and services shaped { port, scheme }. Token-Fleet's
// real registry.json has neither — its top-level keys are schemaVersion,
// machines, sshTargets, services, and a service carries
// { identity, placements, endpoint, configurationSources, changePolicy }.
// Parsing the real file would have failed on at least eight counts. The test
// stayed green only because it built its own synthetic fixture matching the
// obsolete shape rather than validating against the artifact it claimed to
// read — a tautology guarding a fossil.
//
// serviceAuthorities is not merely stale: Token-Fleet excised it as a
// superseded service-topology authority and pins it dead with its own
// adversarial test. This module is the other half of that pin, holding the
// shape from returning on the Terminus side.
//
// These tests hold the export surface too. A re-export is how a deleted module
// comes back into the package's advertised API without anyone importing it.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const self = "test/machine-registry-loader-containment.adversarial.test.ts";
const contracts = join(root, "packages/contracts");

const corpses = [
  "loadMachineRegistry",
  "resolveMachine",
  "TokenFleetMachineRegistry",
  "TOKEN_FLEET_MACHINE_REGISTRY",
  "serviceAuthorities",
];

describe("adversarial: Token-Fleet machine-registry loader containment", () => {
  test("the module and its test are absent from the tree", () => {
    expect(existsSync(join(contracts, "src/machine-config.ts"))).toBe(false);
    expect(existsSync(join(contracts, "test/machine-config.test.ts"))).toBe(false);
  });

  test("the contracts barrel does not re-export the module", () => {
    const barrel = readFileSync(join(contracts, "src/index.ts"), "utf8");
    expect(barrel).not.toContain("machine-config");
    // The barrel must still carry the live contracts; this is not a licence to empty it.
    expect(barrel).toContain("./notification.ts");
    expect(barrel).toContain("./replay.ts");
  });

  test("the package advertises no machine-config subpath", () => {
    const manifest = JSON.parse(readFileSync(join(contracts, "package.json"), "utf8"));
    const subpaths = Object.keys(manifest.exports);
    expect(subpaths).not.toContain("./machine-config");
    expect(subpaths.some((path) => path.includes("machine"))).toBe(false);
    // The surviving surface must still be exported.
    expect(subpaths).toContain("./notification");
  });

  test("no tracked file references the excised loader or its schema", () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
    expect(result.exitCode).toBe(0);
    const violations: string[] = [];
    for (const path of result.stdout.toString().split("\0").filter(Boolean)) {
      if (path === self) continue;
      let content: string;
      try {
        content = readFileSync(join(root, path), "utf8");
      } catch {
        continue;
      }
      for (const corpse of corpses) {
        if (content.includes(corpse)) violations.push(`${path}: references ${corpse}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
