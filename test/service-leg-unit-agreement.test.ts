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
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

const SERVICES = [
  { service: "txd", unit: "packages/txd/systemd/txd.service", leg: "bin/apply-txd" },
  { service: "telemetryd", unit: "packages/telemetryd/systemd/telemetryd.service", leg: "bin/apply-telemetryd" },
  { service: "busd", unit: "packages/busd/systemd/busd.service", leg: "bin/apply-busd" },
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

describe("a service's restart key does not fold in its own installer", () => {
  // terminus-package-fingerprint emits everything a service loads at RUNTIME —
  // that is what its restart stamp keys on. It walks packages/<svc> whole,
  // pruning only node_modules and test. An apply leg placed under
  // packages/<svc>/ therefore lands INSIDE the restart key, and editing the
  // installer would restart the daemon it installs. For txd that means
  // re-minting council identities and retiring every live overseer session to
  // deliver a change the running process cannot observe.
  //
  // The legs live at the repository root instead, outside every package walk,
  // so no prune rule is needed and none is added: this repository's helper stays
  // byte-identical to the Token-Fleet copy it replaces, which is what makes
  // "no stamp moves because of the move" checkable rather than argued.
  const fingerprint = (pkg: string) => {
    const result = spawnSync(join(root, "bin/terminus-package-fingerprint"), [root, pkg], {
      encoding: "utf8", maxBuffer: 1024 * 1024 * 256,
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  test.each(SERVICES)("$service: no apply leg is inside its restart key", ({ service }) => {
    const paths = fingerprint(service).split("\n").filter((line) => line.startsWith("packages/"));
    expect(paths.filter((path) => path.includes("/apply-"))).toEqual([]);
  });

  test.each(SERVICES)("$service: the restart key still reaches its src/", ({ service }) => {
    const paths = fingerprint(service).split("\n");
    expect(paths.some((path) => path.startsWith(`packages/${service}/src/`))).toBe(true);
  });

  test("no apply leg is filed under packages/ at all", () => {
    // The first two tests only see the three services fingerprinted here. This
    // one holds the convention itself, so a leg for a service added later
    // cannot be filed into a package walk that nothing in this file inspects.
    // packages/tx/bin/ is a legitimate CLI helper directory: the rule is about
    // apply legs, not about bin/.
    const listed = spawnSync("git", ["ls-files", "-z", "--", "packages"], { cwd: root, encoding: "utf8" });
    expect(listed.status).toBe(0);
    const offenders = listed.stdout.split("\0").filter(Boolean)
      .filter((path) => (path.split("/").pop() ?? "").startsWith("apply-"));
    expect(offenders).toEqual([]);
  });
});

describe("leg invariants that travelled with the legs", () => {
  // These held in Token-Fleet against its copies of the same scripts. Their
  // subject moved here, so they move here — a deleted pin is lost coverage, and
  // a Token-Fleet test cannot read this repository (its CI has no checkout of
  // it).

  test("no leg re-implements the fleet Bun runtime pin", () => {
    // Exactly one thing links the pinned Bun onto the command PATH: Token-Fleet's
    // apply-fleet-runtime. A leg that did it too would silently take ownership of
    // the fleet-wide version.
    for (const { leg } of SERVICES) {
      expect(read(leg)).not.toContain('ln -sfn "$HOME/.bun/bin/bun"');
    }
  });

  test("txd's restart key includes the installed registration configuration", () => {
    // txd loads its allocation generation from the systemd EnvironmentFile.
    // Omitting it left txd serving a stale allocation digest after
    // registrationd restarted into a new one.
    const leg = read("bin/apply-txd");
    expect(leg).toContain('registration_env="$HOME/.config/token-fleet/txd-registration.env"');
    expect(leg).toContain('cat "$registration_env"');
    expect(leg).toContain("terminus-package-fingerprint");
  });
});
