#!/usr/bin/env node
// Runs the built bundle the way a user would. The unit tests import src/, so they cannot catch what goes wrong
// only in dist/: a dependency bundled from CommonJS, a broken bin header, an import that esbuild resolved differently.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!existsSync(cli)) {
  console.error(`${cli} is missing; run "npm run build" first`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'ssm-commander-smoke-'));
const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SSM_COMMANDER_HOME: home },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? '✔' : '✘'} ${name}`);
  if (!ok) {
    failed += 1;
    console.log(`  got: ${JSON.stringify(got)}`);
  }
};

const version = run(['--version']);
check('--version prints the package version', version.code === 0 && version.out.trim() === pkg.version, version);

const help = run(['--help']);
const commands = ['connect', 'exec', 'forward', 'ssh', 'scp', 'doctor'];
check(
  '--help lists the public commands and hides proxy',
  help.code === 0 && commands.every((c) => help.out.includes(c)) && !/^\s+proxy/m.test(help.out),
  help,
);

const list = run(['forward', '--list']);
check('forward --list works on an empty home', list.code === 0 && list.out.trim() === 'No presets saved', list);

const doctor = run(['doctor']);
check(
  'doctor runs and reports on Node.js (exit 1 is fine where the plugin or profiles are missing)',
  (doctor.code === 0 || doctor.code === 1) && doctor.out.includes('Node.js'),
  doctor,
);

const conflict = run(['forward', '--list', '--delete', 'x']);
check(
  'usage errors go to stderr with exit code 1',
  conflict.code === 1 && conflict.err.includes('cannot be combined'),
  conflict,
);

const mistyped = run(['exsec']);
check(
  'a mistyped command is refused at once with the closest one',
  mistyped.code === 1 &&
    mistyped.err.includes('Unknown command "exsec"') &&
    mistyped.err.includes('ssm-commander exec'),
  mistyped,
);

// The profile does not exist, so the credentials check fails on this machine without reaching AWS.
const before = run(['-p', 'no-such-profile-for-the-smoke-test', 'doctor']);
check(
  '-p before the command reaches the command',
  before.code === 1 && before.out.includes('no-such-profile-for-the-smoke-test'),
  before,
);

rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
