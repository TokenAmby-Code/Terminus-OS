#!/usr/bin/env bun
// tm — telemetryd's STC command interface. It serves exactly the standard
// observation operations and nothing prescriptive: telemetryd is a passive
// ingress, and nothing addresses it beyond asking whether it is sound.
import { createObservationClient } from "@tokenamby-code/stc-contract/client";
import { runningRuntimeMarker } from "@tokenamby-code/stc-contract/version";
import { SERVICE_IDENTITY, SERVICE_VERSION } from "./identity.ts";

const USAGE = [
  "usage: tm <health|inspect|version>",
  "",
  "  tm health    is telemetryd sound; exit 0 only when every probe is ready",
  "  tm inspect   what telemetryd is holding, as quantities; no verdict",
  "  tm version",
].join("\n");

function refuse(message: string): never {
  console.error(message);
  process.exit(64);
}

const argv = Bun.argv.slice(2);
if (argv.length !== 1) refuse(USAGE);
const OPERATIONS = ["health", "inspect", "version"] as const;
type Operation = (typeof OPERATIONS)[number];
const requested = argv[0];
if (!(OPERATIONS as readonly string[]).includes(requested ?? "")) refuse(USAGE);
const operation = { data: requested as Operation };

if (operation.data === "version") {
  process.stdout.write(`${JSON.stringify({ ...SERVICE_IDENTITY, version: SERVICE_VERSION, stc_version: runningRuntimeMarker().version })}\n`);
  process.exit(0);
}

// The daemon is loopback-only behind edge-proxy; TM_URL exists for tests and
// for a deliberately relocated port, never for a remote read.
const request: RequestInit = {};
const agentId = process.env.AGENT_ID;
if (agentId) request.headers = { "x-agent-id": agentId };
const client = createObservationClient({ baseUrl: process.env.TM_URL ?? "http://127.0.0.1:7784", request });

if (operation.data === "inspect") {
  process.stdout.write(`${JSON.stringify(await client.inspect())}\n`);
  process.exit(0);
}
const report = await client.health();
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
