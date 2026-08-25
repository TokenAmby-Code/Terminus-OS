// Origin-device clipboard transfer — behavioral-pin lane.

import { expect, test } from 'bun:test';
import {
  deliverClipboardToOrigin,
  type ClipboardOriginObservation,
} from '../src/clipboard-origin.ts';

const registry = {
  machines: {
    wsl: { tailscaleIp: '100.66.10.74' },
    phone: { tailscaleIp: '100.102.92.24' },
    'k12-personal': { tailscaleIp: '100.95.245.64' },
  },
};

function observation(overrides: Partial<ClipboardOriginObservation> = {}): ClipboardOriginObservation {
  return {
    requested_tty: '/dev/pts/7',
    attached_clients: [
      { tty: '/dev/pts/7', process_id: 710 },
      { tty: '/dev/pts/8', process_id: 810 },
    ],
    process_ancestors: {
      710: { parent_process_id: 700, command: 'tmux -L k12 attach' },
      700: { parent_process_id: 1, command: 'tailscaled be-child ssh --remote-ip=100.66.10.74 --tty-name=pts/7' },
      810: { parent_process_id: 800, command: 'tmux -L k12 attach' },
      800: { parent_process_id: 1, command: 'tailscaled be-child ssh --remote-ip=100.102.92.24 --tty-name=pts/8' },
    },
    ...overrides,
  };
}

test('origin is selected from the attached SSH transport identity, never pane naming', async () => {
  const writes: Array<{ tty: string; bytes: Uint8Array }> = [];
  const result = await deliverClipboardToOrigin(
    new TextEncoder().encode('exact\n雪 😀'),
    observation(),
    registry,
    async (tty, bytes) => { writes.push({ tty, bytes: bytes.slice() }); },
  );
  expect(result).toEqual({ outcome: 'delivered', origin: 'wsl', bytes: 14 });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.tty).toBe('/dev/pts/7');
  expect(writes[0]?.bytes).toEqual(new TextEncoder().encode('exact\n雪 😀'));
});

test('phone and WSL clients never receive each others clipboard transfer', async () => {
  const writes: string[] = [];
  const result = await deliverClipboardToOrigin(
    new TextEncoder().encode('phone only'),
    observation({ requested_tty: '/dev/pts/8' }),
    registry,
    async (tty) => { writes.push(tty); },
  );
  expect(result).toMatchObject({ outcome: 'delivered', origin: 'phone' });
  expect(writes).toEqual(['/dev/pts/8']);
});

test('disconnected, unsupported, and refused transports are typed and have no cross-device effect', async () => {
  let writes = 0;
  await expect(deliverClipboardToOrigin(
    new TextEncoder().encode('private-disconnected'),
    observation({ requested_tty: '/dev/pts/9' }),
    registry,
    async () => { writes += 1; },
  )).resolves.toEqual({ outcome: 'disconnected_origin', bytes: 20 });

  await expect(deliverClipboardToOrigin(
    new TextEncoder().encode('private-unsupported'),
    observation({
      process_ancestors: {
        710: { parent_process_id: 700, command: 'tmux attach' },
        700: { parent_process_id: 1, command: 'tailscaled be-child ssh --remote-ip=100.95.245.64' },
      },
    }),
    registry,
    async () => { writes += 1; },
  )).resolves.toEqual({ outcome: 'unsupported_origin', origin: 'k12-personal', bytes: 19 });

  await expect(deliverClipboardToOrigin(
    new TextEncoder().encode('private-refusal'),
    observation(),
    registry,
    async () => { throw new Error('terminal write contained private-refusal'); },
  )).resolves.toEqual({ outcome: 'transport_refused', origin: 'wsl', bytes: 15 });
  expect(writes).toBe(0);
});

test('diagnostics and typed outcomes never contain clipboard content', async () => {
  const secret = 'origin-clipboard-secret-never-log';
  const diagnostics: unknown[] = [];
  const result = await deliverClipboardToOrigin(
    new TextEncoder().encode(secret),
    observation(),
    registry,
    async () => {},
    (entry) => diagnostics.push(entry),
  );
  expect(JSON.stringify({ result, diagnostics })).not.toContain(secret);
});
