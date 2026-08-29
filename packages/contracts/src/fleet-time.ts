import { join } from 'node:path';

type Environment = Record<string, string | undefined>;

const ISO_INSTANT_SOURCE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z';
const ISO_INSTANT = new RegExp(`^${ISO_INSTANT_SOURCE}$`);
const ISO_INSTANT_IN_TEXT = new RegExp(ISO_INSTANT_SOURCE, 'g');

function machineConfigRoot(env: Environment): string {
  const configured = env.TOKEN_FLEET_MACHINE_CONFIG_ROOT;
  if (configured) return configured;
  const home = env.HOME;
  if (!home) throw new Error('HOME is required to resolve the Token-Fleet runtime baseline');
  return join(home, 'runtimes', 'Token-Fleet', 'live', 'machines');
}

export async function loadFleetTimezone(env: Environment = process.env): Promise<string> {
  const path = join(machineConfigRoot(env), 'k12-common', 'runtime-baseline.json');
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`fleet runtime baseline does not exist: ${path}`);
  const document = await file.json() as { host_baseline?: { timezone?: unknown } };
  const timezone = document.host_baseline?.timezone;
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new Error(`fleet runtime baseline carries no timezone: ${path}`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new Error(`fleet runtime baseline carries an invalid IANA timezone: ${path}`);
  }
  process.env.TZ = timezone;
  return timezone;
}

export function formatHumanInstant(instant: string | Date, timezone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new Error(`invalid instant: ${JSON.stringify(instant)}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  const [year, month, day, hour, minute, second, zone] = [
    part('year'), part('month'), part('day'), part('hour'),
    part('minute'), part('second'), part('timeZoneName'),
  ];
  if (!year || !month || !day || !hour || !minute || !second || !zone) {
    throw new Error(`could not render instant in fleet timezone ${JSON.stringify(timezone)}`);
  }
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${zone}`;
}

export function renderHumanTimestamps<T>(value: T, timezone: string): T {
  if (typeof value === 'string') {
    return (ISO_INSTANT.test(value) ? formatHumanInstant(value, timezone) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderHumanTimestamps(entry, timezone)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      renderHumanTimestamps(entry, timezone),
    ])) as T;
  }
  return value;
}

export function stringifyHuman(value: unknown, timezone: string, space?: string | number): string {
  return JSON.stringify(renderHumanTimestamps(value, timezone), null, space);
}

export function renderHumanText(value: string, timezone: string): string {
  return value.replace(ISO_INSTANT_IN_TEXT, (instant) => formatHumanInstant(instant, timezone));
}
