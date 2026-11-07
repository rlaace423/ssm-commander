// Runs the real `connect` flow against a fictitious fleet so the README recording shows the whole
// experience (profiles, the searchable table with its Note column, a session) without touching AWS.
// Bundled by demo/build.mjs and driven by demo/record.exp; not part of the published package.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Ec2Summary, mergeInstances, type SsmSummary, sortInstances } from '../src/aws/instances.js';
import { type ConnectDeps, runConnect } from '../src/commands/connect.js';
import { spawnInherited } from '../src/session/spawn-inherited.js';
import { emptyHistory, recordConnection } from '../src/storage/history.js';
import { pickInstance } from '../src/ui/instance-picker.js';
import { info, spinner, warn } from '../src/ui/output.js';
import { promptProfile, requireTty } from '../src/ui/prompts.js';

const REGION = 'ap-northeast-2';
const PROFILES = ['default', 'staging', 'prod'];
const FAKE_SESSION = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-session.mjs');

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
let chosenProfile = PROFILES[0] ?? 'default';

const deps: ConnectDeps = {
  resolveContext: async () => {
    requireTty();
    chosenProfile = await promptProfile(PROFILES);
    return {
      profile: chosenProfile,
      region: REGION,
      credentials: async () => ({ accessKeyId: 'demo', secretAccessKey: 'demo' }),
    };
  },
  listInstances: async (_ctx, opts) => {
    await pause(700); // long enough for the spinner to be seen
    return { rows: sortInstances(mergeInstances(FLEET, AGENTS), opts.recentIds), ssmUnavailable: false };
  },
  pickInstance,
  runSession: (ctx, input) => {
    const privateIp = FLEET.find((i) => i.instanceId === input.Target)?.privateIp ?? '10.0.0.1';
    return spawnInherited(process.execPath, [FAKE_SESSION, ctx.profile, privateIp], process.env);
  },
  // api-1 was connected before, so it shows up first with the recent marker.
  loadHistory: async () =>
    recordConnection(
      emptyHistory(),
      { profile: chosenProfile, region: REGION, instanceId: 'i-0f3a9c1d2e4b5a601', instanceName: 'api-1' },
      new Date(),
    ),
  saveHistory: async () => {},
  configDir: '/nonexistent',
  now: () => new Date(),
  warn,
  info,
  spinner,
  requireTty: () => requireTty(),
};

process.exitCode = await runConnect(undefined, {}, deps);
