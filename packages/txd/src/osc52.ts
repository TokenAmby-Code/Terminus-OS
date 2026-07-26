import { open } from 'node:fs/promises';
import { CLIPBOARD_BUFFER_NAME, MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';

export function validateClipboardBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error(`clipboard payload exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('clipboard payload is not valid UTF-8');
  }
}

export async function readBoundedClipboard(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CLIPBOARD_BYTES) {
        await reader.cancel();
        throw new Error(`clipboard payload exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function osc52Sequence(bytes: Uint8Array): Uint8Array {
  validateClipboardBytes(bytes);
  return new TextEncoder().encode(`\u001b]52;c;${Buffer.from(bytes).toString('base64')}\u0007`);
}

export function validateAttachedClientTty(requested: string, attached: readonly string[]): string {
  if (!/^\/dev\/(?:pts\/[0-9]+|tty[A-Za-z0-9._-]*)$/.test(requested)) {
    throw new Error('invoking client tty is invalid');
  }
  if (!attached.includes(requested)) throw new Error('invoking client tty is not attached');
  return requested;
}

type RunResult = { code: number; stdout: string; stderr: string };
type Run = (args: string[], stdin?: Uint8Array) => Promise<RunResult>;

async function runTmux(socket: string, args: string[], stdin?: Uint8Array): Promise<RunResult> {
  const proc = Bun.spawn(['tmux', '-L', socket, ...args], {
    stdin: stdin === undefined ? undefined : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function pushSelectionToClient(
  bytes: Uint8Array,
  tty: string,
  socket: string,
  deps: {
    run?: Run;
    writeTty?: (path: string, data: Uint8Array) => Promise<void>;
  } = {},
): Promise<number> {
  const run = deps.run ?? ((args, stdin) => runTmux(socket, args, stdin));
  const clients = await run(['list-clients', '-F', '#{client_tty}']);
  if (clients.code !== 0) throw new Error('attached clients are unavailable');
  const target = validateAttachedClientTty(
    tty,
    clients.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  );
  try {
    validateClipboardBytes(bytes);
    const loaded = await run(['load-buffer', '-b', CLIPBOARD_BUFFER_NAME, '-'], bytes);
    if (loaded.code !== 0) throw new Error('could not load tx-clipboard');
    const marked = await run(['set-option', '-g', '@tx_clipboard_empty', bytes.byteLength === 0 ? '1' : '0']);
    if (marked.code !== 0) throw new Error('could not mark tx-clipboard state');
    const writeTty = deps.writeTty ?? (async (path, data) => {
      const handle = await open(path, 'w');
      try { await handle.write(data); } finally { await handle.close(); }
    });
    await writeTty(target, osc52Sequence(bytes));
    await run(['display-message', '-c', target, `clipboard push succeeded (${bytes.byteLength} bytes)`]);
    return bytes.byteLength;
  } catch (error) {
    await run(['display-message', '-c', target, `clipboard push failed (${bytes.byteLength} bytes)`]);
    throw error;
  }
}
