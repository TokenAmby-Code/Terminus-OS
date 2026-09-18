export const HEALTH_VERDICTS = {
  OK: 0,
  WARNING: 1,
  CRITICAL: 2,
  UNKNOWN: 3,
} as const;

export type HealthReport = {
  probes: ReadonlyArray<{ rung: string; state: string }>;
};

export function healthExitCode(report: HealthReport): 0 | 1 | 2 | 3 {
  if (report.probes.some((probe) => probe.state === "undetermined")) return HEALTH_VERDICTS.UNKNOWN;
  if (report.probes.every((probe) => probe.state === "ready")) return HEALTH_VERDICTS.OK;
  if (report.probes.some((probe) => probe.rung === "function" && probe.state === "ready")) {
    return HEALTH_VERDICTS.WARNING;
  }
  return HEALTH_VERDICTS.CRITICAL;
}
