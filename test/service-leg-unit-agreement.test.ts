// A service's apply leg and the unit it installs are one artifact.
//
// Each of these legs validates the unit it is about to install, and among the
// pins is the unit's exact `WorkingDirectory`. While the leg lived in
// Token-Fleet and the unit in Terminus-OS, the two repositories converged
// independently, so that agreement was unenforceable and the path was unable to
// change in either order: land the unit first and the leg refuses it, land the
// leg first and it refuses the still-old unit.
//
// Now that both live here, the agreement is a property of one commit — which is
// the whole reason the legs moved. These tests hold it that way.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(import.meta.dir, "..");

const SERVICES = [
  { service: "txd", unit: "packages/txd/systemd/txd.service", leg: "packages/txd/bin/apply-txd" },
  { service: "telemetryd", unit: "packages/telemetryd/systemd/telemetryd.service", leg: "packages/telemetryd/bin/apply-telemetryd" },
  { service: "busd", unit: "packages/busd/systemd/busd.service", leg: "packages/busd/bin/apply-busd" },
] as const;

const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("apply leg and installed unit agree", () => {
  test.each(SERVICES)("$service: the leg pins the WorkingDirectory its unit declares", ({ unit, leg }) => {
    const declared = read(unit)
      .split("\n")
      .filter((line) => line.startsWith("WorkingDirectory="));
    expect(declared).toHaveLength(1);

    // The leg asserts the literal with `grep -qx`, so the pinned string is the
    // unit line verbatim. A drifting unit fails here instead of at converge.
    expect(read(leg)).toContain(`grep -qx '${declared[0]}'`);
  });

  test.each(SERVICES)("$service: the leg resolves the fingerprint helper inside this repository", ({ leg }) => {
    const source = read(leg);
    expect(source).toContain('"$terminus/bin/terminus-package-fingerprint"');
    // The helper is no longer reachable through the fleet checkout: a leg that
    // still looked for it there would fail only on a live converge.
    expect(source).not.toContain("shared/bin/terminus-package-fingerprint");
  });

  test.each(SERVICES)("$service: the leg carries no restart-control branch", ({ leg }) => {
    // A restart control is a root artifact the machine baseline installs from
    // the Token-Fleet registry. A leg outside that repository never trampolines
    // into the installer to declare its own.
    expect(read(leg)).not.toContain("FLEET_RESTART_CONTROLS_ONLY");
  });
});
