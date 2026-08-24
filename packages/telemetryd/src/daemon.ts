import { DEFAULT_DB_CONFIG, describeEndpoint } from "@terminus-os/db";
import { notifyReady } from "@terminus-os/systemd";
import { makeServer } from "./server.ts";
import { PostgresTelemetryStore } from "./store.ts";


const bind = process.env.TELEMETRYD_BIND ?? "127.0.0.1";
const port = Number(process.env.TELEMETRYD_PORT ?? "7784");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TELEMETRYD_PORT must be a valid port");

const db = DEFAULT_DB_CONFIG.remote;
const store = await PostgresTelemetryStore.connect(db);
const build = { version: "0.1.0", git_sha: process.env.GIT_SHA ?? "unknown", bun: Bun.version };
const server = makeServer({ store, build, bind, port });

console.log(JSON.stringify({ level: "info", event: "listening", service: "telemetryd", bind, port, db: describeEndpoint(db), build }));

// The ingress is bound and the store is connected: the same edge the log above
// records, told to systemd. Under Type=notify this write is what completes the
// start job, so `systemctl restart telemetryd.service` returns here rather than
// at fork — which is what makes a deploy leg's restart a readiness fact instead
// of a fork fact.
notifyReady();

async function shutdown(): Promise<void> {
  await server.stop();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
