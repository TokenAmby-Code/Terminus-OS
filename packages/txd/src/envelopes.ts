// Remote envelope observation for ssh seats.
//
// The envelope is a one-pane tmux session on the seat's target machine,
// created by the local agent-wrapper as `tmux new-session -A` and named from
// the seat id and the launch nonce. The nonce-bearing name is the reconnect
// address and the cross-kernel correlation: txd derives the same name from
// its launch composition, so a remote session claiming a seat is believed
// only when its name carries the nonce txd minted for the live pane
// generation. A zombie envelope is one alive after its binding retired — it
// holds no lock and no seat; visibility and reaping are estate-side only.

import { spawn } from 'node:child_process';

export const ENVELOPE_PREFIX = 'txd-';

// tmux session names refuse ':' and '.'; the envelope name keeps the seat
// legible by mapping every byte outside [A-Za-z0-9_-] to '-'.
export function envelopeSessionName(seatId: string, launchNonce: string): string {
  const sanitized = seatId.replaceAll(/[^A-Za-z0-9_-]/g, '-');
  return `${ENVELOPE_PREFIX}${sanitized}-${launchNonce}`;
}

/** List tmux session names live on the target machine (by machines.json alias). */
export type RemoteEnvelopeLister = (target: string) => Promise<string[]>;

// The estate ssh pattern: alias resolution and the keepalive contract live in
// the generated ~/.ssh/config; BatchMode keeps an unreachable target a loud,
// bounded failure instead of a prompt. "no server running" is an empty
// inventory, not an error — the target simply has no envelopes.
export const realRemoteEnvelopeLister: RemoteEnvelopeLister = (target) =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      target,
      'tmux', 'list-sessions', '-F', '#{session_name}',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.split('\n').filter(Boolean));
        return;
      }
      // A target with no tmux server holds zero envelopes, in every dialect
      // tmux speaks it: a running-then-exited server says "no server
      // running"; a box whose server never started says "error connecting to
      // <socket> (No such file or directory)". Anything else stays loud.
      if (/no server running|no sessions|no such file or directory/i.test(stderr)) {
        resolve([]);
        return;
      }
      reject(new Error(`envelope_inventory_failed:${target}:${stderr.trim() || code}`));
    });
  });
