// Runs the real commands against a fictitious fleet so the README recordings show the whole experience
// (profiles, the searchable table with its Note column, sessions, presets) without touching AWS.
// Bundled by demo/build.mjs, started through demo/run.mjs and driven by demo/record.exp.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '@aws-sdk/client-ecs';
import {
  type ClusterRow,
  type ServiceSummary,
  sortTasks,
  type TaskRow,
  toClusterRow,
  toTaskRow,
} from '../src/aws/ecs.js';
import { type Ec2Summary, mergeInstances, type SsmSummary, sortInstances } from '../src/aws/instances.js';
import { main } from '../src/cli.js';
import type { ConnectDeps } from '../src/commands/connect.js';
import type { ExecDeps } from '../src/commands/exec.js';
import { FORWARD_DOCUMENT, type ForwardDeps } from '../src/commands/forward.js';
import type { SshDeps } from '../src/commands/ssh.js';
import { spawnInherited } from '../src/session/spawn-inherited.js';
import { emptyHistory, recordConnection, recordExec } from '../src/storage/history.js';
import { loadPresets, savePresets } from '../src/storage/presets.js';
import type { AwsContext, StartSessionInput } from '../src/types.js';
import { descriptionInput } from '../src/ui/description-input.js';
import { pickCluster, pickContainer, pickService, pickTask } from '../src/ui/ecs-picker.js';
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

// A small ECS estate for the exec demo: two clusters, a service without exec, and a scheduled task.
const ECS_ACCOUNT = 'arn:aws:ecs:ap-northeast-2:123456789012';
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const ecsTask = (cluster: string, id: string, group: string, startedHoursAgo: number, over: Partial<Task> = {}) =>
  toTaskRow(
    {
      taskArn: `${ECS_ACCOUNT}:task/${cluster}/${id}`,
      lastStatus: 'RUNNING',
      desiredStatus: 'RUNNING',
      healthStatus: 'HEALTHY',
      group,
      launchType: 'FARGATE',
      startedAt: hoursAgo(startedHoursAgo),
      availabilityZone: 'ap-northeast-2a',
      enableExecuteCommand: true,
      taskDefinitionArn: `${ECS_ACCOUNT}:task-definition/${group.split(':')[1]}:42`,
      containers: [
        {
          name: 'app',
          runtimeId: `${id}-0001`,
          lastStatus: 'RUNNING',
          managedAgents: [{ name: 'ExecuteCommandAgent', lastStatus: 'RUNNING' }],
        },
      ],
      ...over,
    },
    cluster,
  );
const ecsService = (name: string, desired: number, running: number, execEnabled = true): ServiceSummary => ({
  name,
  arn: `${ECS_ACCOUNT}:service/prod/${name}`,
  desired,
  running,
  launchType: 'FARGATE',
  taskDefinition: `${name}:42`,
  execEnabled,
  status: 'ACTIVE',
});
const CLUSTERS: ClusterRow[] = [
  toClusterRow({
    clusterName: 'prod',
    clusterArn: `${ECS_ACCOUNT}:cluster/prod`,
    status: 'ACTIVE',
    activeServicesCount: 3,
    runningTasksCount: 5,
  }),
  toClusterRow({
    clusterName: 'staging',
    clusterArn: `${ECS_ACCOUNT}:cluster/staging`,
    status: 'ACTIVE',
    activeServicesCount: 2,
    runningTasksCount: 2,
  }),
];
const SERVICES: Record<string, ServiceSummary[]> = {
  prod: [ecsService('api', 2, 2), ecsService('worker', 1, 1), ecsService('legacy', 1, 1, false)],
  staging: [ecsService('api', 1, 1), ecsService('worker', 1, 1)],
};
const TASKS: Record<string, TaskRow[]> = {
  prod: [
    ecsTask('prod', '3f9c1d2e4b5a60017a8b9c0d1e2f3a4b', 'service:api', 26),
    ecsTask('prod', '7b2e9f0a1c3d4e5f60718293a4b5c6d7', 'service:api', 3),
    ecsTask('prod', 'c4d5e6f708192a3b4c5d6e7f80912a3b', 'service:worker', 50),
    ecsTask('prod', 'e1f2a3b4c5d6e7f8091a2b3c4d5e6f70', 'service:legacy', 200, { enableExecuteCommand: false }),
    ecsTask('prod', '9a8b7c6d5e4f30211203f4e5d6c7b8a9', 'family:nightly-report', 1),
  ],
  staging: [
    ecsTask('staging', '0a1b2c3d4e5f60718293a4b5c6d7e8f9', 'service:api', 5),
    ecsTask('staging', '5e6f708192a3b4c5d6e7f8091a2b3c4d', 'service:worker', 5),
  ],
};

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

// api-1 and the prod/api service were used before, so they show up first with the recent marker.
const loadHistory = async () =>
  recordExec(
    recordConnection(
      emptyHistory(),
      { profile: chosenProfile, region: REGION, instanceId: 'i-0f3a9c1d2e4b5a601', instanceName: 'api-1' },
      new Date(),
    ),
    { profile: chosenProfile, region: REGION, cluster: 'prod', service: 'api' },
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

// The exec command gets the ECS estate above; the fake session plays the container shell.
const exec: ExecDeps = {
  resolveContext,
  ecsClient: async () => ({ send: async () => ({}) }),
  fetchClusters: async () => {
    await pause(600);
    return CLUSTERS;
  },
  fetchServices: async (_ecs, cluster) => SERVICES[cluster] ?? [],
  fetchTasks: async (_ecs, cluster, service) => {
    await pause(600);
    return sortTasks((TASKS[cluster] ?? []).filter((t) => service === undefined || t.service === service));
  },
  describeTask: async (_ecs, cluster, taskId) => (TASKS[cluster] ?? []).find((t) => t.taskId === taskId) ?? null,
  pickCluster,
  pickService,
  pickTask: (rows, service) => pickTask(rows, service),
  pickContainer,
  runExecSession: (ctx, input) =>
    spawnInherited(process.execPath, [FAKE_SESSION, 'exec', ctx.profile, input.container], process.env),
  requireTty: () => requireTty(),
  info,
  spinner,
  loadHistory,
  saveHistory: async () => {},
  configDir: DEMO_HOME,
  now: () => new Date(),
};

const forward: ForwardDeps = {
  ...common,
  ecs: exec,
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

process.exitCode = await main(process.argv, { connect, forward, ssh, scp: ssh, exec });
