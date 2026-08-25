// The one declaration of what telemetryd is, read by the daemon's observation
// surface and by the tm CLI's version operation alike.
export const SERVICE_IDENTITY = { service: "telemetryd", daemon: "telemetryd", cli: "tm" } as const;
export const SERVICE_VERSION = "0.1.0";
