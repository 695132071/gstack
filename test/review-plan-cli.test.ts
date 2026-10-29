import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): { dir: string; state: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-state-'));
  dirs.push(dir, state);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  git('add', '.'); git('commit', '-qm', 'feat');
  return { dir, state };
}
const run = (r: { dir: string; state: string }, args: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });

describe('gstack-review-plan', () => {
  test('a docs-only diff plans no dispatch and says why', () => {
    const r = run(repo({ 'docs/howto.md': '# How to\nStep one.\n' }), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
    expect(r.stdout).toContain('SKIP: outside-voice (docs class, no numeric claims)');
  });
  test('a docs diff that publishes numbers keeps the outside voice', () => {
    const r = run(repo({ 'docs/bench.md': 'Median latency fell 42% to 180 ms.\n' }), []);
    expect(r.stdout).toContain('DISPATCH: outside-voice outside-voice effort=host');
  });
  test('--json carries the class, the next step, every dispatch with its effort and the audit effort; --no-tiers renders audits at host effort', () => {
    const r = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan).toMatchObject({ class: 'code', next: { step: 'full' }, pass: 0 });
    expect(plan.dispatches.find((d: any) => d.role === 'specialist').effort).toBe('full');
    expect(plan.audit_effort).toBe('light');
    expect(JSON.parse(run(r, ['--json', '--no-tiers']).stdout).audit_effort).toBe('host');
  });
  test('a below-floor fix after pass 1 plans one fix-check', () => {
    const r = run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'full', '--fixed-below']);
    expect(r.stdout).toContain('next=fix-check dispatches=1');
    expect(r.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
  });
  test('--fix-check-prompt renders the fix-check reviewer prompt from the parent\'s files and refuses a missing one', () => {
    const r = repo({ 'docs/howto.md': '# x\n' });
    const w = (n: string, t: string) => { const f = path.join(r.state, n); fs.writeFileSync(f, t); return f; };
    const files = ['--fix-list', w('fix.txt', 'lib/a.ts:3 guard now refuses unknown'), '--hunks', w('hunks.diff', '+if (s !== "MERGED") return false;'), '--tests', w('tests.txt', '12 pass 0 fail')];
    const ok = spawnSync(BIN, ['--fix-check-prompt', ...files], { cwd: r.dir, encoding: 'utf8', timeout: 60_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('You are the fix-check reviewer');
    expect(ok.stdout).toContain('lib/a.ts:3 guard now refuses unknown');
    expect(ok.stdout).toContain('(none found)');
    const missing = spawnSync(BIN, ['--fix-check-prompt', '--fix-list', path.join(r.state, 'nope.txt'), '--hunks', files[3]!, '--tests', files[5]!], { cwd: r.dir, encoding: 'utf8', timeout: 60_000 });
    expect(missing.status).toBe(2);
  });
  test('untracked files count, a version-only package.json bump stays docs, and review_effort_tiers off renders audits at host effort', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
    git('add', '.'); git('commit', '-qm', 'package');
    git('checkout', '-q', 'feat'); git('reset', '-q', '--hard', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
    git('commit', '-qam', 'stamp');
    const stamp = JSON.parse(run(r, ['--json']).stdout);
    expect(stamp.stamp_only).toContain('package.json');
    expect(stamp.class).toBe('docs');
    fs.mkdirSync(path.join(r.dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'lib', 'new.ts'), 'export const a = 1;\n');
    const withUntracked = JSON.parse(run(r, ['--json']).stdout);
    expect(withUntracked.paths).toContain('lib/new.ts');
    expect(withUntracked.class).toBe('code');
    const cfg = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'off'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(cfg.status).toBe(0);
    expect(JSON.parse(run(r, ['--json']).stdout).audit_effort).toBe('host');
    const bad = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'maybe'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("review_effort_tiers 'maybe' not recognized");
  });
  test('without --gate-tagged the plan runs the gate scan itself', () => {
    const r = repo({ 'lib/a.ts': 'export const a = 1;\n' });
    const res = spawnSync(BIN, ['--base', 'main', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(res.status, res.stderr).toBe(0);
    expect(typeof JSON.parse(res.stdout).gate_tagged).toBe('number');
  });
  test('usage errors exit 2', () => {
    expect(spawnSync(BIN, [], { encoding: 'utf8', timeout: 10_000 }).status).toBe(2);
    expect(run(repo({ 'a.md': 'x' }), ['--last', 'later']).status).toBe(2);
  });
  test('scratch under .gstack/tmp/ is ignored, a subdirectory run plans the whole repository, and --adversarial-ran drops the repeat adversarial pass', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    fs.mkdirSync(path.join(r.dir, '.gstack', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.gstack', 'tmp', 'fix-check-list.ts'), 'export const x = 1;\n');
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan.class).toBe('docs');
    expect(plan.paths).toEqual(['docs/a.md']);
    const sub = spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--json'], { cwd: path.join(r.dir, 'docs'), encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(JSON.parse(sub.stdout).paths).toEqual(['docs/a.md']);
    const code = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const repeat = ['--pass', '1', '--last', 'full', '--fixed-blocking'];
    expect(run(code, repeat).stdout).toContain('DISPATCH: adversarial-native adversarial effort=full');
    const ran = run(code, [...repeat, '--adversarial-ran']).stdout;
    expect(ran).not.toContain('DISPATCH: adversarial-native');
    expect(ran).toContain('SKIP: adversarial-native and outside-voice (run once per invocation)');
  });
});

describe('gstack-review-plan: review depth', () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  test('prints REVIEW_DEPTH with runtime lines and the rules hash, and GATE_SCAN bound to the head', () => {
    const r = repo({ 'src/a.ts': code(10), 'test/a.test.ts': code(200) });
    const out = run(r, []).stdout;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    expect(out).toMatch(/^REVIEW_DEPTH: light runtime_lines=10 rules=[0-9a-f]{16} reasons=runtime=10<=50 codes=none$/m);
    expect(out).toContain(`GATE_SCAN: tagged=0 head=${head}`);
    expect(out).toContain('DISPATCH: specialist batched effort=full checklists=testing,maintainability,security,performance,state-machines,red-team');
    expect(out).toContain('DISPATCH: adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)');
  });
  test('DIFF_CMD is shell-quoted per dispatch and excludes what the reviewer does not read; DIFF_EXCLUDE: none when empty', () => {
    const r = repo({ 'src/a.ts': code(80), 'docs/my notes*.md': '# n\n', 'test/a.test.ts': code(3) });
    const out = run(r, []).stdout;
    expect(out).toContain("DIFF_CMD: testing git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md'");
    expect(out).toContain("DIFF_CMD: maintainability git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md' ':(exclude)test/a.test.ts'");
    expect(out).toContain('DIFF_CMD: adversarial git diff <diff-base>\nDIFF_EXCLUDE: adversarial none');
    const cmd = /^DIFF_CMD: maintainability (.*)$/m.exec(out)![1]!.replace('<diff-base>', 'main');
    const diff = spawnSync('bash', ['-c', cmd.replace('git diff main', 'git diff --name-only main')], { cwd: r.dir, encoding: 'utf8' });
    expect(diff.stdout.trim().split('\n')).toEqual(['src/a.ts']);
  });
  test('--json carries depth, runtime_lines, rules, errors, gate_scan and every dispatch\'s exclude array', () => {
    const r = repo({ 'src/a.ts': code(80), 'README.md': '# y\n' });
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan).toMatchObject({ depth: 'standard', step_depth: 'standard', runtime_lines: 80, errors: [], codes: [], gate_scan: { tagged: 0 } });
    expect(plan.rules).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.dispatches.find((d: any) => d.name === 'maintainability').exclude).toEqual([':(exclude)README.md']);
    expect(plan.dispatches.find((d: any) => d.role === 'outside-voice').exclude).toEqual([]);
  });
  test('--depth-floor full raises a light diff, never lowers a full one, and an invalid floor is a usage error', () => {
    const r = repo({ 'src/a.ts': code(5) });
    expect(run(r, ['--depth-floor', 'full']).stdout).toMatch(/^REVIEW_DEPTH: full runtime_lines=5 .*reasons=runtime=5<=50,floor:full /m);
    const gate = repo({ 'src/a.ts': code(5), '.github/workflows/ci.yml': 'on: push\n' });
    expect(run(gate, ['--depth-floor', 'standard']).stdout).toMatch(/^REVIEW_DEPTH: full /m);
    expect(run(r, ['--depth-floor', 'light']).status).toBe(2);
  });
  test('a conservative full plan exits 0 with its errors; a plan that cannot be built exits 1', () => {
    const r = repo({ 'lib/x.wasm': '\u0000asm\u0000' });
    const res = run(r, ['--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ depth: 'full', errors: expect.arrayContaining([expect.objectContaining({ code: 'binary_code_path', input: 'lib/x.wasm' })]) });
    expect(run(r, []).stdout).toContain('DEPTH_ERROR: binary_code_path input=lib/x.wasm');
    const none = spawnSync(BIN, ['--base', 'no-such-branch', '--gate-tagged', '0'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(none.status).toBe(1);
  });
});

