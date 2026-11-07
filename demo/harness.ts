// Runs the real commands against a fictitious fleet so the README recordings show the whole experience
// (profiles, the searchable table with its Note column, sessions, presets) without touching AWS.
// Bundled by demo/build.mjs, started through demo/run.mjs and driven by demo/record.exp.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Ec2Summary, mergeInstances, type SsmSummary, sortInstances } from '../src/aws/instances.js';
import { main } from '../src/cli.js';
import type { ConnectDeps } from '../src/commands/connect.js';
import { FORWARD_DOCUMENT, type ForwardDeps } from '../src/commands/forward.js';
import type { SshDeps } from '../src/commands/ssh.js';
import { spawnInherited } from '../src/session/spawn-inherited.js';
import { emptyHistory, recordConnection } from '../src/storage/history.js';
import { loadPresets, savePresets } from '../src/storage/presets.js';
import type { AwsContext, StartSessionInput } from '../src/types.js';
import { descriptionInput } from '../src/ui/description-input.js';
import { pickInstance } from '../src/ui/instance-picker.js';
import { info, spinner, warn } from '../src/ui/output.js';
import { confirmOverwrite, promptIo, promptProfile, requireTty } from '../src/ui/prompts.js';

const REGION = 'ap-northeast-2';
const PROFILES = ['default', 'staging', 'prod'];
const FAKE_SESSION = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-session.mjs');
// Presets saved during a recording live here, so a later command in the same recording can reuse them.
const DEMO_HOME = process.env.DEMO_HOME ?? mkdtempSync(join(tmpdir(), 'ssm-commander-demo-'));

// Public IPs come from the RFC 5737 documentation ranges, so they never point at a real host.
const FLEET: Ec2Summary[] = [
  {
    instanceId: 'i-0f3a9c1d2e4b5a601',
    name: 'api-1',
    state: 'running',
    instanceType: 't3.medium',
    privateIp: '10.0.1.12',
    publicIp: '203.0.113.10',
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a602',
    name: 'api-2',
    state: 'running',
    instanceType: 't3.medium',
    privateIp: '10.0.1.13',
    publicIp: null,
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a603',
    name: 'worker-1',
    state: 'running',
    instanceType: 't3.large',
    privateIp: '10.0.2.40',
    publicIp: null,
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a604',
    name: 'bastion',
    state: 'running',
    instanceType: 't3.micro',
    privateIp: '10.0.0.5',
    publicIp: '198.51.100.7',
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a605',
    name: 'legacy-db',
    state: 'stopped',
    instanceType: 'r5.large',
    privateIp: '10.0.3.7',
    publicIp: null,
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a606',
    name: 'monitoring',
    state: 'running',
    instanceType: 't3.small',
    privateIp: '10.0.2.9',
    publicIp: null,
  },
  {
    instanceId: 'i-0f3a9c1d2e4b5a607',
    name: 'jenkins',
    state: 'running',
    instanceType: 'm5.large',
    privateIp: '10.0.2.21',
    publicIp: null,
  },
];

const online = (instanceId: string, privateIp: string): SsmSummary => ({
  instanceId,
  pingStatus: 'Online',
  platformName: 'Amazon Linux',
  computerName: `ip-${privateIp.replaceAll('.', '-')}.${REGION}.compute.internal`,
});
// legacy-db (stopped) and jenkins (no agent) are missing on purpose; monitoring lost its connection.
const AGENTS: SsmSummary[] = [
  online('i-0f3a9c1d2e4b5a601', '10.0.1.12'),
  online('i-0f3a9c1d2e4b5a602', '10.0.1.13'),
  online('i-0f3a9c1d2e4b5a603', '10.0.2.40'),
  online('i-0f3a9c1d2e4b5a604', '10.0.0.5'),
  { ...online('i-0f3a9c1d2e4b5a606', '10.0.2.9'), pingStatus: 'ConnectionLost' },
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const privateIpOf = (instanceId: string) => FLEET.find((i) => i.instanceId === instanceId)?.privateIp ?? '10.0.0.1';
const credentials = async () => ({ accessKeyId: 'demo', secretAccessKey: 'demo' });
let chosenProfile = 'default';

async function resolveContext(opts: { profile?: string; region?: string }): Promise<AwsContext> {
  if (opts.profile === undefined) requireTty();
  chosenProfile = opts.profile ?? (await promptProfile(PROFILES));
  return { profile: chosenProfile, region: opts.region ?? REGION, credentials };
}

async function listInstances(_ctx: AwsContext, opts: { recentIds: string[] }) {
  await pause(700); // long enough for the spinner to be seen
  return { rows: sortInstances(mergeInstances(FLEET, AGENTS), opts.recentIds), ssmUnavailable: false };
}

// api-1 was connected before, so it shows up first with the recent marker.
const loadHistory = async () =>
  recordConnection(
    emptyHistory(),
    { profile: chosenProfile, region: REGION, instanceId: 'i-0f3a9c1d2e4b5a601', instanceName: 'api-1' },
    new Date(),
  );

// The fake session plays the plugin: an interactive shell, or a port forwarding that waits for Ctrl+C.
function runSession(ctx: AwsContext, input: StartSessionInput): Promise<number> {
  const args =
    input.DocumentName === FORWARD_DOCUMENT
      ? ['forward', ctx.profile, input.Parameters?.localPortNumber?.[0] ?? '0']
      : ['connect', ctx.profile, privateIpOf(input.Target)];
  return spawnInherited(process.execPath, [FAKE_SESSION, ...args], process.env);
}

const common = {
  resolveContext,
  listInstances,
  pickInstance,
  loadHistory,
  configDir: DEMO_HOME,
  info,
  warn,
  spinner,
  requireTty: () => requireTty(),
};

const connect: ConnectDeps = { ...common, runSession, saveHistory: async () => {}, now: () => new Date() };

const forward: ForwardDeps = {
  ...common,
  runSession,
  loadPresets,
  savePresets,
  descriptionInput: (config) => descriptionInput(config, promptIo),
  confirmOverwrite,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
};

// The system ssh/scp are replaced by the fake session, which reads the user and target out of the arguments.
const ssh: SshDeps = {
  ...common,
  selfCommand: () => ['ssm-commander'],
  spawn: (command, args, options) => {
    const instanceId = args.find((arg) => /^i-[0-9a-f]+/.test(arg)) ?? '';
    return spawn(process.execPath, [FAKE_SESSION, command, privateIpOf(instanceId), ...args], options);
  },
};

process.exitCode = await main(process.argv, { connect, forward, ssh, scp: ssh });
