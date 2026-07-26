import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';

export type LocalClipboard = {
  target: 'windows' | 'android';
  get(): Promise<string>;
  set(value: string): Promise<void>;
};

type ProcessResult = { code: number; stdout: Uint8Array; stderr: string };
type RunProcess = (argv: string[], stdin?: Uint8Array) => Promise<ProcessResult>;

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('local clipboard exceeds 1 MiB');
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

export async function runProcess(argv: string[], stdin?: Uint8Array): Promise<ProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? undefined : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    throw new Error(`local clipboard capability unavailable: ${argv[0]} not found`);
  }
  if (stdin !== undefined) {
    const sink = proc.stdin as Bun.FileSink;
    sink.write(stdin);
    sink.end();
  }
  try {
    const [stdout, stderr, code] = await Promise.all([
      readLimited(proc.stdout as ReadableStream<Uint8Array>, MAX_CLIPBOARD_BYTES),
      readLimited(proc.stderr as ReadableStream<Uint8Array>, MAX_CLIPBOARD_BYTES)
        .then((bytes) => new TextDecoder().decode(bytes)),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    proc.kill();
    throw error;
  }
}

export function validateLocalClipboard(value: string): Uint8Array {
  if (!value.isWellFormed()) throw new Error('local clipboard is not valid UTF-8');
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('local clipboard exceeds 1 MiB');
  return bytes;
}

function decodeClipboard(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('local clipboard exceeds 1 MiB');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('local clipboard is not valid UTF-8'); }
}

function checked(result: ProcessResult, capability: string): Uint8Array {
  if (result.code !== 0) throw new Error(`${capability} failed or is unavailable`);
  return result.stdout;
}

export function createLocalClipboard(
  env: Record<string, string | undefined> = process.env,
  run: RunProcess = runProcess,
): LocalClipboard {
  const termux = Boolean(env.TERMUX_VERSION || env.PREFIX?.includes('com.termux'));
  if (termux) {
    return {
      target: 'android',
      get: async () => decodeClipboard(checked(
        await run(['termux-clipboard-get']),
        'Termux:API clipboard (install the Termux:API app and package)',
      )),
      set: async (value) => {
        const result = await run(['termux-clipboard-set'], validateLocalClipboard(value));
        checked(result, 'Termux:API clipboard (install the Termux:API app and package)');
      },
    };
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    const base = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'];
    return {
      target: 'windows',
      get: async () => decodeClipboard(checked(
        await run([...base, '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $value = Get-Clipboard -Raw; [Console]::Out.Write($value)']),
        'Windows PowerShell clipboard',
      )),
      set: async (value) => {
        const result = await run(
          [...base, '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value'],
          validateLocalClipboard(value),
        );
        checked(result, 'Windows PowerShell clipboard');
      },
    };
  }
  throw new Error('local clipboard adapter unavailable: run tx clipboard from WSL or Termux');
}
