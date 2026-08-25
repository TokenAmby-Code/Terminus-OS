import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';

export type ClipboardOrigin = 'wsl' | 'phone';
export type ClipboardOriginOutcome =
  | { outcome: 'delivered'; origin: ClipboardOrigin; bytes: number }
  | { outcome: 'unsupported_origin'; origin?: string; bytes: number }
  | { outcome: 'disconnected_origin'; bytes: number }
  | { outcome: 'transport_refused'; origin: ClipboardOrigin; bytes: number };

export type ClipboardOriginObservation = {
  requested_tty: string;
  attached_clients: Array<{ tty: string; process_id: number }>;
  process_ancestors: Record<number, { parent_process_id: number; command: string }>;
};

export type ClipboardMachineRegistry = {
  machines: Record<string, { tailscaleIp?: string }>;
};

function validateClipboardBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('clipboard payload exceeds 1 MiB');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('clipboard payload is not valid UTF-8'); }
}

export function parseClipboardMachineRegistry(value: unknown): ClipboardMachineRegistry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('clipboard machine registry must be an object');
  }
  const machines = (value as { machines?: unknown }).machines;
  if (typeof machines !== 'object' || machines === null || Array.isArray(machines)) {
    throw new Error('clipboard machine registry must contain machines');
  }
  const parsed: ClipboardMachineRegistry['machines'] = {};
  for (const [name, raw] of Object.entries(machines)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`clipboard machine registry entry ${name} is invalid`);
    }
    const tailscaleIp = (raw as { tailscaleIp?: unknown }).tailscaleIp;
    if (tailscaleIp !== undefined && (typeof tailscaleIp !== 'string' || tailscaleIp.length === 0)) {
      throw new Error(`clipboard machine registry entry ${name} has invalid tailscaleIp`);
    }
    parsed[name] = tailscaleIp === undefined ? {} : { tailscaleIp };
  }
  return { machines: parsed };
}

type DiagnosticSink = (entry: {
  operation: 'clipboard_origin_transfer';
  outcome: ClipboardOriginOutcome['outcome'];
  origin?: string;
  bytes: number;
}) => void;

function transportAddress(
  start: number,
  ancestors: ClipboardOriginObservation['process_ancestors'],
): string | undefined {
  const visited = new Set<number>();
  let processId = start;
  while (processId > 1 && !visited.has(processId)) {
    visited.add(processId);
    const process = ancestors[processId];
    if (!process) return undefined;
    const match = process.command.match(/(?:^|\s)--remote-ip=([^\s]+)/);
    if (match?.[1]) return match[1];
    processId = process.parent_process_id;
  }
  return undefined;
}

function machineForAddress(address: string, registry: ClipboardMachineRegistry): string | undefined {
  return Object.entries(registry.machines)
    .find(([, machine]) => machine.tailscaleIp === address)?.[0];
}

function supportedOrigin(machine: string | undefined): ClipboardOrigin | undefined {
  return machine === 'wsl' || machine === 'phone' ? machine : undefined;
}

export async function deliverClipboardToOrigin(
  bytes: Uint8Array,
  observation: ClipboardOriginObservation,
  registry: ClipboardMachineRegistry,
  write: (tty: string, bytes: Uint8Array) => Promise<void>,
  diagnostic: DiagnosticSink = () => {},
): Promise<ClipboardOriginOutcome> {
  validateClipboardBytes(bytes);
  const metadata = { bytes: bytes.byteLength };
  const client = observation.attached_clients.find(({ tty }) => tty === observation.requested_tty);
  if (!client) {
    const result = { outcome: 'disconnected_origin', ...metadata } as const;
    diagnostic({ operation: 'clipboard_origin_transfer', ...result });
    return result;
  }

  const address = transportAddress(client.process_id, observation.process_ancestors);
  const machine = address === undefined ? undefined : machineForAddress(address, registry);
  const origin = supportedOrigin(machine);
  if (!origin) {
    const result = {
      outcome: 'unsupported_origin',
      ...(machine === undefined ? {} : { origin: machine }),
      ...metadata,
    } as const;
    diagnostic({ operation: 'clipboard_origin_transfer', ...result });
    return result;
  }

  try {
    await write(client.tty, bytes);
  } catch {
    const result = { outcome: 'transport_refused', origin, ...metadata } as const;
    diagnostic({ operation: 'clipboard_origin_transfer', ...result });
    return result;
  }
  const result = { outcome: 'delivered', origin, ...metadata } as const;
  diagnostic({ operation: 'clipboard_origin_transfer', ...result });
  return result;
}
