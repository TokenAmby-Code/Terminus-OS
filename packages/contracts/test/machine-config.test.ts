import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineRegistry, resolveMachine } from "../src/machine-config.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "terminus-machine-registry-")); dirs.push(dir);
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, serviceAuthorities: { "terminus-api": "hub" }, machines: { hub: { role: "authority", hostnames: ["Hub"], domain: "personal", tailscaleIp: "100.64.0.1", ssh: { alias: "hub", user: "token" }, runtimeRoots: {}, vaultRoots: {} } }, sshTargets: ["hub"], services: { "terminus-api": { port: 7777, scheme: "http" } } }));
  return path;
}

test("loads the Token-Fleet generated contract from the explicit path", () => {
  const registry = loadMachineRegistry(fixture());
  expect(resolveMachine(registry, "hub.local")).toBe("hub");
});

test("has no implicit registry or unknown-host fallback", () => {
  const saved = process.env.TOKEN_FLEET_MACHINE_REGISTRY; delete process.env.TOKEN_FLEET_MACHINE_REGISTRY;
  try { expect(() => loadMachineRegistry()).toThrow(/required/); } finally { if (saved) process.env.TOKEN_FLEET_MACHINE_REGISTRY = saved; }
  const registry = loadMachineRegistry(fixture());
  expect(() => resolveMachine(registry, "mystery")).toThrow(/unregistered/);
  expect(() => resolveMachine(registry, "Hub", "mystery")).toThrow(/unregistered/);
});
