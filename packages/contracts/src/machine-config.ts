import { readFileSync } from "node:fs";
import { z } from "zod";

const machineSchema = z.strictObject({
  role: z.string().min(1),
  hostnames: z.array(z.string().min(1)).min(1),
  domain: z.string().min(1),
  tailscaleIp: z.string().min(1),
  ssh: z.strictObject({ alias: z.string().min(1), user: z.string().min(1) }),
  runtimeRoots: z.record(z.string(), z.string()),
  vaultRoots: z.record(z.string(), z.string()),
  ci: z.strictObject({ port: z.string(), base: z.string() }).optional(),
});

export const TokenFleetMachineRegistry = z.strictObject({
  schemaVersion: z.literal(1),
  serviceAuthorities: z.record(z.string(), z.string()),
  machines: z.record(z.string(), machineSchema),
  sshTargets: z.array(z.string()),
  services: z.record(z.string(), z.strictObject({ port: z.number().int().positive(), scheme: z.string().min(1) })),
});
export type TokenFleetMachineRegistry = z.infer<typeof TokenFleetMachineRegistry>;

/** Read Token-Fleet's generated contract directly; no Terminus daemon or fallback registry. */
export function loadMachineRegistry(path = process.env.TOKEN_FLEET_MACHINE_REGISTRY): TokenFleetMachineRegistry {
  if (!path) throw new Error("TOKEN_FLEET_MACHINE_REGISTRY is required");
  return TokenFleetMachineRegistry.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function resolveMachine(registry: TokenFleetMachineRegistry, hostname: string, override?: string): string {
  if (override) {
    if (registry.machines[override]) return override;
    throw new Error(`unregistered IMPERIUM_MACHINE: ${override}`);
  }
  const normalized = hostname.split(".")[0]!.toLowerCase();
  for (const [machine, spec] of Object.entries(registry.machines)) {
    if (spec.hostnames.some((candidate) => candidate.toLowerCase() === normalized)) return machine;
  }
  throw new Error(`unregistered machine hostname: ${normalized}`);
}
