import { describe, test, expect, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive } from '../src/error-handling';
import {
  isAgentRecordGone, isOurAgent, readAgentStartTime, spawnTerminalAgent, stopAgentByRecord, win32CreationTimeSource, writeAgentRecord,
  type AgentRecord,
} from '../src/terminal-agent-control';

// REGRESSION TEST for the Windows terminal-agent leak.
//
// Symptom (reported on Windows 11, 48GB box under a heavy parallel build):
// a console window popped to the foreground every 60 seconds, and orphaned
// `bun run terminal-agent.ts` processes accumulated at one per minute until
// the machine ran out of committable memory.
//
// Root cause was a three-bug chain, each of which this file pins:
//
//   1. `isProcessAlive` shelled out to `tasklist` on Windows with a 3s
//      timeout. A Bun.spawnSync that hits its timeout STILL RETURNS, carrying
//      partial stdout — so the `.includes()` PID match came back false and a
//      LIVE agent was reported dead. Measured tasklist latency was 700-1700ms
//      idle, and far worse under memory pressure, so the timeout was reachable
//      in ordinary use.
//   2. That false negative made `killAgentByRecord` skip the kill (it
//      validates liveness first) while the watchdog respawned anyway —
//      leaking the survivor. Each orphan added memory pressure, slowing the
//      next tasklist, producing the next false negative. Self-reinforcing.
//   3. Neither the tasklist probe nor the agent spawn passed `windowsHide`,
//      so every tick allocated a visible console and stole focus.
//
// The guard-window arithmetic bug that let this run unbounded instead of
// tripping the crash-loop guard is pinned separately, in test 6.

const SRC_DIR = path.resolve(import.meta.dir, '..', 'src');

function readAllSourceFiles(): Array<{ file: string; content: string }> {
  return fs
    .readdirSync(SRC_DIR)
    .filter((e) => e.endsWith('.ts'))
    .map((e) => ({ file: e, content: fs.readFileSync(path.join(SRC_DIR, e), 'utf-8') }));
}

/** Strip line and block comments so static greps only see real code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('process liveness probe (Windows terminal-agent leak)', () => {
  test('1. isProcessAlive reports the current process alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('2. isProcessAlive reports an unused PID dead', () => {
    // Below Linux PID_MAX_LIMIT, far above any realistic Windows/macOS PID.
    expect(isProcessAlive(2147483646)).toBe(false);
  });

  test('2b. EPERM means ALIVE: an unsignalable-but-existing PID is not dead (T2)', () => {
    // signal-0 to a process we lack permission over throws EPERM — the
    // process EXISTS, we just can't signal it. Treating EPERM as "dead" is
    // the false negative that leaked agents. PID 1 (launchd/init) on POSIX
    // and PID 4 (System) on Windows always exist and are either signalable
    // or EPERM — both must read as alive.
    expect(isProcessAlive(process.platform === 'win32' ? 4 : 1)).toBe(true);
  });

  test('3. isProcessAlive spawns NO subprocess on ANY platform (signal-0, #1952)', () => {
    // The heart of the bug: a liveness probe that forks is slow enough to
    // time out, and a timed-out probe silently answers "dead". Signal 0
    // cannot time out because it never leaves the process. Node maps
    // process.kill(pid, 0) to an OpenProcess existence check on Windows —
    // and the Windows daemon runs under Node (server-node.mjs +
    // bun-polyfill), so the POSIX idiom is portable and the win32 tasklist
    // branch is GONE (it caused both the false negatives above and the
    // per-tick console flash of #1952).
    const origSpawn = (Bun as any).spawn;
    const origSpawnSync = (Bun as any).spawnSync;
    const spawns: string[] = [];
    (Bun as any).spawn = (...args: any[]) => { spawns.push(`spawn:${JSON.stringify(args[0])}`); return origSpawn(...args); };
    (Bun as any).spawnSync = (...args: any[]) => { spawns.push(`spawnSync:${JSON.stringify(args[0])}`); return origSpawnSync(...args); };
    try {
      isProcessAlive(process.pid);
      isProcessAlive(2147483646);
      expect(spawns).toEqual([]);
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).spawnSync = origSpawnSync;
    }
  });

  test('4. no source file probes liveness via tasklist — signal-0 is the only probe (#1952)', () => {
    // Static tripwire: a tasklist existence check ANYWHERE in src/
    // resurrects both the false-negative class (#2414: a timed-out spawnSync
    // still returns, with partial stdout, so a live process reads as dead)
    // and the per-tick console flash (#1952). isProcessAlive uses
    // process.kill(pid, 0) on every platform; nothing gets an exemption.
    const offenders: string[] = [];
    for (const { file, content } of readAllSourceFiles()) {
      const code = stripComments(content);
      // `PID eq` is the existence-probe form specifically. Other tasklist
      // uses (e.g. IMAGENAME filters for browser detection) are unaffected.
      if (/tasklist/.test(code) && /PID eq/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('5. spawnTerminalAgent passes windowsHide so no console is shown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hide-'));
    const script = path.join(tmpDir, 'fake-agent.ts');
    fs.writeFileSync(script, '// no-op\n');
    const origSpawn = (Bun as any).spawn;
    const originalProbe = Bun.spawnSync;
    const originalWindowsProbe = childProcess.spawnSync;
    const probe = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[], options: any) => {
      if (command[0] === 'ps' && command[2] === String(process.pid)) {
        return { exitCode: 0, stdout: Buffer.from('fixture-owner-start'), stderr: Buffer.alloc(0) };
      }
      return originalProbe(command, options);
    }) as typeof Bun.spawnSync);
    const powershellCalls: string[] = [];
    const windowsProbe = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: any) => {
      if (command === 'powershell.exe') {
        powershellCalls.push(args.join(' '));
        const owner = args.join(' ').includes(`ProcessId = ${process.pid}'`);
        return { status: 0, stdout: JSON.stringify(owner ? { CreationDate: 'fixture-owner-start', CommandLine: 'test-owner' } : null), stderr: '' };
      }
      return originalWindowsProbe(command, args, options);
    }) as typeof childProcess.spawnSync);
    const exited = Promise.resolve(0);
    let captured: any = null;
    (Bun as any).spawn = (_cmd: any, opts: any) => {
      captured = opts;
      return { pid: 2147483647, exited, kill() {}, unref() {} };
    };
    try {
      expect(() => spawnTerminalAgent({
        stateFile: path.join(tmpDir, 'state.json'),
        serverPort: 12345,
        ownerPid: process.pid,
        cwd: tmpDir,
        scriptPath: script,
      })).toThrow('terminal-agent process identity is unavailable');
      expect(captured).not.toBeNull();
      expect(captured.windowsHide).toBe(true);
      // Owner-PID lifetime tie (#2019): the agent polls this and exits when
      // its owning browse server dies, so it can't be adopted by PID 1.
      expect(captured.env.BROWSE_OWNER_PID).toBe(String(process.pid));
      if (process.platform === 'win32') {
        expect(captured.env.BROWSE_OWNER_START_TIME).toMatch(/^\/Date\(\d+\)\/$/);
        expect(captured.env.BROWSE_OWNER_START_TIME).toBe(readAgentStartTime(process.pid));
        expect(powershellCalls.filter(call => call.includes(`ProcessId = ${process.pid}'`))).toEqual([]);
        expect(powershellCalls.every(call => call.includes("ProcessId = 2147483647'"))).toBe(true);
      } else {
        expect(captured.env.BROWSE_OWNER_START_TIME).toBe('fixture-owner-start');
      }
      // Detached background daemon — must not inherit a terminal either.
      expect(captured.stdio).toEqual(['ignore', 'ignore', 'ignore']);
      await exited;
      expect(fs.existsSync(path.join(tmpDir, 'terminal-agent-pid'))).toBe(false);
    } finally {
      (Bun as any).spawn = origSpawn;
      windowsProbe.mockRestore();
      probe.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('6. respawn guard window spans enough ticks for the guard to fire', () => {
    // The guard was `RESPAWN_GUARD_WINDOW_MS = 60_000` against a 60_000ms
    // tick, allowing at most ONE respawn in the window — so the
    // `>= RESPAWN_GUARD_MAX (3)` trip condition was unreachable and a steady
    // one-per-tick leak never self-limited. Assert the window is derived from
    // the tick rather than fixed.
    const src = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf-8');
    const match = src.match(/const RESPAWN_GUARD_WINDOW_MS =([\s\S]{0,160}?);/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('AGENT_WATCHDOG_TICK_MS');

    // Pin the arithmetic itself: at the default tick, three respawns must fit.
    const tick = 60_000;
    const guardMax = 3;
    const windowMs = Math.max(60_000, tick * (guardMax + 2));
    expect(windowMs).toBeGreaterThanOrEqual(tick * guardMax);
  });
});

describe('win32 terminal-agent identity (GSTA-139)', () => {
  const pid = 2147483645;
  const gen = 'win32-identity-generation';
  const birth = '/Date(1761600000123)/';
  const ownedCommand = `"C:\\bun\\bun.exe" run terminal-agent.ts --agent-gen=${gen}`;
  const record = (startTime = birth): AgentRecord => ({ pid, gen, startTime, startedAt: 0, ownerPid: pid, ownerStartTime: birth });
  type PowerShell = { status: number | null; creationDate?: string; commandLine?: string };

  function onWin32(scenario: { ffi: string | undefined; powershell: PowerShell }, run: (calls: { powershell: number; signals: unknown[] }) => void): void {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const calls = { powershell: 0, signals: [] as unknown[] };
    let live = true;
    const kill = spyOn(process, 'kill').mockImplementation(((target: number, signal: unknown) => {
      expect(target).toBe(pid);
      if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal !== 0) { calls.signals.push(signal); live = false; }
      return true;
    }) as typeof process.kill);
    const read = spyOn(win32CreationTimeSource, 'read').mockImplementation((target: number) => (target === pid && live ? scenario.ffi : undefined));
    const probe = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string) => {
      expect(command).toBe('powershell.exe');
      calls.powershell++;
      const { status, creationDate, commandLine } = scenario.powershell;
      return status === 0
        ? { status, stdout: JSON.stringify({ CreationDate: creationDate, CommandLine: commandLine }), stderr: '' }
        : { status, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    }) as typeof childProcess.spawnSync);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      run(calls);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      probe.mockRestore();
      read.mockRestore();
      kill.mockRestore();
    }
  }

  test('the start time is read in-process, so a PowerShell launch killed at its timeout cannot empty it', () => {
    onWin32({ ffi: birth, powershell: { status: null } }, calls => {
      expect(readAgentStartTime(pid)).toBe(birth);
      expect(calls.powershell).toBe(0);
    });
  });

  test('without the in-process reader (Node daemon) the start time falls back to the PowerShell CreationDate', () => {
    onWin32({ ffi: undefined, powershell: { status: 0, creationDate: birth, commandLine: ownedCommand } }, calls => {
      expect(readAgentStartTime(pid)).toBe(birth);
      expect(calls.powershell).toBe(1);
    });
  });

  test('kill-time ownership still requires the generation in the PowerShell command line', () => {
    onWin32({ ffi: birth, powershell: { status: 0, creationDate: birth, commandLine: ownedCommand } }, calls => {
      expect(isOurAgent(record())).toBe(true);
      expect(stopAgentByRecord(record(), 0)).toBe(true);
      expect(calls.signals).toEqual(['SIGTERM']);
    });
    for (const powershell of [{ status: 0, creationDate: birth, commandLine: 'bun run unrelated.ts' }, { status: null }]) {
      onWin32({ ffi: birth, powershell }, calls => {
        expect(isOurAgent(record())).toBe(false);
        expect(isAgentRecordGone(record())).toBe(false);
        expect(stopAgentByRecord(record(), 0)).toBe(false);
        expect(calls.signals).toEqual([]);
      });
    }
    onWin32({ ffi: '/Date(1761600000124)/', powershell: { status: 0, creationDate: birth, commandLine: 'bun run unrelated.ts' } }, calls => {
      expect(isAgentRecordGone(record())).toBe(true);
      expect(calls.signals).toEqual([]);
    });
  });

  test('a start time that disagrees across readers still identifies the live agent by its generation, so no second agent starts', () => {
    const daemonRecorded = '/Date(1761596400123)/';
    onWin32({ ffi: birth, powershell: { status: 0, creationDate: daemonRecorded, commandLine: ownedCommand } }, calls => {
      expect(isAgentRecordGone(record(daemonRecorded))).toBe(false);
      expect(isOurAgent(record(daemonRecorded))).toBe(true);
      expect(stopAgentByRecord(record(daemonRecorded), 0)).toBe(true);
      expect(calls.signals).toEqual(['SIGTERM']);
    });
    onWin32({ ffi: birth, powershell: { status: null } }, calls => {
      expect(isAgentRecordGone(record(daemonRecorded))).toBe(false);
      expect(stopAgentByRecord(record(daemonRecorded), 0)).toBe(false);
      expect(calls.signals).toEqual([]);
    });
  });

  test('an unreadable start time is unknown: never signalled and never treated as gone', () => {
    onWin32({ ffi: undefined, powershell: { status: null } }, calls => {
      expect(readAgentStartTime(pid)).toBe('');
      expect(isOurAgent(record())).toBe(false);
      expect(isAgentRecordGone(record())).toBe(false);
      expect(stopAgentByRecord(record(), 0)).toBe(false);
      expect(calls.signals).toEqual([]);
    });
  });

  test.skipIf(process.platform !== 'win32')('the in-process start time equals the CreationDate earlier releases recorded', () => {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      for (const target of [process.pid, child.pid]) {
        const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${target}' | Select-Object CreationDate | ConvertTo-Json -Compress)`;
        const legacy = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
        expect(legacy.status).toBe(0);
        const recorded = JSON.parse(legacy.stdout).CreationDate;
        expect(recorded).toMatch(/^\/Date\(\d+\)\/$/);
        expect(win32CreationTimeSource.read(target)).toBe(recorded);
        expect(readAgentStartTime(target)).toBe(recorded);
      }
    } finally {
      child.kill();
    }
  }, 150_000);

  test.skipIf(process.platform !== 'win32')('a live agent whose identity cannot be read blocks a second agent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-unknown-'));
    const script = path.join(tmpDir, 'fake-agent.ts');
    fs.writeFileSync(script, '// no-op\n');
    const live = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
    writeAgentRecord(tmpDir, { pid: live.pid, gen, startTime: birth, startedAt: 0, ownerPid: process.pid, ownerStartTime: birth });
    const original = childProcess.spawnSync;
    const probe = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: any) => (
      command === 'powershell.exe' ? { status: null, stdout: '', stderr: '' } : original(command, args, options)
    )) as typeof childProcess.spawnSync);
    const read = spyOn(win32CreationTimeSource, 'read').mockImplementation(() => undefined);
    const origSpawn = (Bun as any).spawn;
    let spawned = 0;
    (Bun as any).spawn = () => { spawned++; throw new Error('a second agent must not start'); };
    try {
      expect(spawnTerminalAgent({ stateFile: path.join(tmpDir, 'state.json'), serverPort: 12345, ownerPid: process.pid, cwd: tmpDir, scriptPath: script })).toBeNull();
      expect(spawned).toBe(0);
      expect(isProcessAlive(live.pid)).toBe(true);
    } finally {
      (Bun as any).spawn = origSpawn;
      read.mockRestore();
      probe.mockRestore();
      live.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
