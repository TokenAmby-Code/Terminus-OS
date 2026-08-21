import type { HookDiagnostic } from '@terminus-os/contracts';

type JournalRow = {
  __REALTIME_TIMESTAMP?: unknown;
  PRIORITY?: unknown;
  MESSAGE?: unknown;
};

function diagnostic(row: JournalRow): HookDiagnostic | null {
  if (typeof row.MESSAGE !== 'string') return null;
  const micros = typeof row.__REALTIME_TIMESTAMP === 'string' ? Number(row.__REALTIME_TIMESTAMP) : Number.NaN;
  const priority = typeof row.PRIORITY === 'string' ? Number(row.PRIORITY) : Number.NaN;
  return {
    recorded_at: Number.isSafeInteger(micros) ? new Date(Math.floor(micros / 1000)).toISOString() : 'unknown',
    priority: Number.isInteger(priority) && priority >= 0 && priority <= 7 ? priority : 6,
    message: row.MESSAGE,
  };
}

export async function readHookDiagnostics(limit: number): Promise<HookDiagnostic[]> {
  const proc = Bun.spawn([
    'journalctl', '--identifier=txd-tmux-hook', '--output=json', '--no-pager', `--lines=${limit}`,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`txd hook journal unreadable: ${stderr.trim() || `journalctl exited ${code}`}`);
  return stdout.split('\n').filter(Boolean).map((line) => {
    try { return diagnostic(JSON.parse(line) as JournalRow); }
    catch { throw new Error('txd hook journal returned invalid JSON'); }
  }).filter((row): row is HookDiagnostic => row !== null);
}
