// @terminus-os/discord — the Terminus-OS Discord tenant on k12-personal.
//
// Capability-driven identities (Custodes + Guard; Mechanicus reserved-but-unprovisioned),
// env-only credentials (no Keychain, no inline secrets), the voice-channel operator transport,
// and the device-agnostic text-channel notification router. Host/systemd application is owned
// by Token-Fleet; this package is the executable tenant and its typed contracts.
export * from "./capability.ts";
export * from "./identity.ts";
export * from "./config.ts";
export * from "./notify.ts";
export * from "./voice.ts";
export * from "./service.ts";
export * from "./gateway.ts";
export * from "./main.ts";
