import { existsSync } from 'node:fs';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { SharedConfigFiles } from '@smithy/types';
import { createEcsClient, createIamClient, createStsClient } from '../aws/clients.js';
import {
  describeTask,
  describeTaskDefinition,
  type ExecTarget,
  fetchServices,
  fetchTasks,
  parseExecTarget,
  type ServiceSummary,
  type TaskDefinitionSummary,
  type TaskRow,
} from '../aws/ecs.js';
import { simulateRole } from '../aws/iam.js';
import { listProfileNames, loadSharedConfig, profileRegion, resolveRegion } from '../aws/profiles.js';
import { resolveContext } from '../context.js';
import { CliError, describeAwsError, PLUGIN_INSTALL_URL } from '../errors.js';
import { compareVersions, findPluginPath, getPluginVersion, RECOMMENDED_MIN_VERSION } from '../session/plugin.js';
import type { AwsContext, Sender } from '../types.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Passed, but something could not be verified; rendered with `!`. */
  warning?: boolean;
  detail: string;
}

/** What a task role must allow for ECS Exec (the agent opens its channels with these). */
export const SSMMESSAGES_ACTIONS = [
  'ssmmessages:CreateControlChannel',
  'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenControlChannel',
  'ssmmessages:OpenDataChannel',
] as const;
const FARGATE_MIN_PLATFORM = '1.4.0';

export interface EcsDoctorDeps {
  ecsClient: (ctx: AwsContext) => Promise<Sender>;
  iamClient: (ctx: AwsContext) => Promise<Sender>;
  fetchServices: (ecs: Sender, cluster: string) => Promise<ServiceSummary[]>;
  fetchTasks: (ecs: Sender, cluster: string, service?: string) => Promise<TaskRow[]>;
  describeTask: (ecs: Sender, cluster: string, taskId: string) => Promise<TaskRow | null>;
  describeTaskDefinition: (ecs: Sender, arn: string) => Promise<TaskDefinitionSummary>;
  simulateRole: (iam: Sender, roleArn: string, actions: string[]) => Promise<Record<string, string>>;
}

export interface DoctorDeps {
  ecs: EcsDoctorDeps;
  nodeVersion: string;
  findPluginPath: () => string | null;
  getPluginVersion: (pluginPath: string) => Promise<string | null>;
  loadSharedConfig: () => Promise<SharedConfigFiles>;
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  getCallerIdentity: (ctx: AwsContext) => Promise<{ Account?: string; Arn?: string }>;
  writeStdout: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const MIN_NODE_MAJOR = 22;

export function defaultDoctorDeps(): DoctorDeps {
  return {
    ecs: {
      ecsClient: (ctx) => createEcsClient(ctx),
      iamClient: (ctx) => createIamClient(ctx),
      fetchServices,
      fetchTasks,
      describeTask,
      describeTaskDefinition,
      simulateRole,
    },
    nodeVersion: process.versions.node,
    findPluginPath: () => findPluginPath({ env: process.env, platform: process.platform, exists: existsSync }),
    getPluginVersion,
    loadSharedConfig,
    resolveContext: (opts) => resolveContext(opts),
    getCallerIdentity: (ctx) => createStsClient(ctx).send(new GetCallerIdentityCommand({})),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    env: process.env,
  };
}

function checkNode(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: 'Node.js', ok: true, detail: `v${version}` }
    : { name: 'Node.js', ok: false, detail: `v${version} (${MIN_NODE_MAJOR} or newer is required)` };
}

async function checkPlugin(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'session-manager-plugin';
  const pluginPath = deps.findPluginPath();
  if (pluginPath === null) return { name, ok: false, detail: `not found on PATH (install: ${PLUGIN_INSTALL_URL})` };
  const version = await deps.getPluginVersion(pluginPath);
  if (version === null) return { name, ok: true, detail: `${pluginPath} (version unknown)` };
  const outdated = compareVersions(version, RECOMMENDED_MIN_VERSION) < 0;
  return {
    name,
    ok: true,
    detail: `${version} at ${pluginPath}${outdated ? ` (older than recommended ${RECOMMENDED_MIN_VERSION})` : ''}`,
  };
}

function checkConfigFiles(files: SharedConfigFiles): DoctorCheck {
  const name = 'AWS config files';
  const profiles = listProfileNames(files);
  if (profiles.length === 0) {
    return { name, ok: false, detail: 'no profiles found in ~/.aws/config or ~/.aws/credentials' };
  }
  return {
    name,
    ok: true,
    detail: `${profiles.length} profile${profiles.length === 1 ? '' : 's'}: ${profiles.join(', ')}`,
  };
}

/** STS works in any region, so the check never prompts for one. */
const FALLBACK_REGION = 'us-east-1';

async function checkCredentials(profile: string, files: SharedConfigFiles, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = `Credentials for "${profile}"`;
  try {
    const region = resolveRegion({ env: deps.env, profileRegion: profileRegion(files, profile) }) ?? FALLBACK_REGION;
    const ctx = await deps.resolveContext({ profile, region });
    const identity = await deps.getCallerIdentity(ctx);
    return { name, ok: true, detail: `account ${identity.Account ?? '?'}, ${identity.Arn ?? 'unknown identity'}` };
  } catch (err) {
    return { name, ok: false, detail: describeAwsError(err, { profile }).message };
  }
}

function checkTask(task: TaskRow): DoctorCheck {
  const name = 'Task';
  const platform = task.platformVersion ? ` ${task.platformVersion}` : '';
  const label = `${task.taskId} ${task.lastStatus}, ${task.launchType ?? 'unknown launch type'}${platform}`;
  if (task.lastStatus !== 'RUNNING') return { name, ok: false, detail: `${label} (must be RUNNING)` };
  if (!task.execEnabled) {
    return {
      name,
      ok: false,
      detail: `${label}, exec disabled (the task was started before enableExecuteCommand was set; redeploy the service)`,
    };
  }
  if (
    task.launchType === 'FARGATE' &&
    task.platformVersion &&
    compareVersions(task.platformVersion, FARGATE_MIN_PLATFORM) < 0
  ) {
    return { name, ok: false, detail: `${label}: ECS Exec needs platform version ${FARGATE_MIN_PLATFORM} or newer` };
  }
  return { name, ok: true, detail: `${label}, exec enabled` };
}

function checkAgent(task: TaskRow): DoctorCheck {
  const name = 'Exec agent';
  const running = task.containers.filter((c) => c.agentStatus === 'RUNNING').map((c) => c.name);
  if (running.length > 0) return { name, ok: true, detail: `RUNNING in ${running.join(', ')}` };
  const states = task.containers.filter((c) => c.agentStatus !== null).map((c) => `${c.agentStatus} in ${c.name}`);
  if (states.length === 0) {
    return {
      name,
      ok: false,
      detail:
        'no ExecuteCommandAgent in the task (check the platform version and that it was started with exec enabled)',
    };
  }
  return {
    name,
    ok: false,
    detail: `${states.join(', ')} (give a new task a minute; if it stays, check the task role and the network path to ssmmessages)`,
  };
}

async function checkTaskRole(ctx: AwsContext, ecs: Sender, task: TaskRow, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'Task role';
  if (!task.taskDefinitionArn) return { name, ok: false, detail: 'task definition unknown' };
  const definition = await deps.ecs.describeTaskDefinition(ecs, task.taskDefinitionArn);
  if (definition.taskRoleArn === null) {
    return {
      name,
      ok: false,
      detail: `no task role on ${task.taskDefinition ?? task.taskDefinitionArn} (ECS Exec needs a task role allowing ${SSMMESSAGES_ACTIONS.join(', ')})`,
    };
  }
  const roleName = definition.taskRoleArn.split('/').pop() ?? definition.taskRoleArn;
  try {
    const iam = await deps.ecs.iamClient(ctx);
    const decisions = await deps.ecs.simulateRole(iam, definition.taskRoleArn, [...SSMMESSAGES_ACTIONS]);
    const denied = SSMMESSAGES_ACTIONS.filter((action) => decisions[action] !== 'allowed');
    return denied.length === 0
      ? { name, ok: true, detail: `${roleName} allows the ssmmessages channel actions` }
      : { name, ok: false, detail: `${roleName} lacks ${denied.join(', ')}` };
  } catch (err) {
    const why = describeAwsError(err, { profile: ctx.profile }).message;
    return { name, ok: true, warning: true, detail: `${roleName} is attached; could not verify its policies (${why})` };
  }
}

/** The ECS Exec prerequisites of one service (its newest task) or of one task: what amazon-ecs-exec-checker checks. */
async function ecsExecChecks(ctx: AwsContext, target: ExecTarget, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const cluster = target.cluster as string;
  const service = target.service as string;
  const serviceName = `ECS service ${cluster}/${service}`;
  const checks: DoctorCheck[] = [];
  try {
    const ecs = await deps.ecs.ecsClient(ctx);
    const summary = (await deps.ecs.fetchServices(ecs, cluster)).find((s) => s.name === service);
    if (summary === undefined) {
      checks.push({ name: serviceName, ok: false, detail: `not found in cluster "${cluster}"` });
      return checks;
    }
    checks.push(
      summary.execEnabled
        ? {
            name: serviceName,
            ok: true,
            detail: `execute command enabled, ${summary.running}/${summary.desired} tasks running`,
          }
        : {
            name: serviceName,
            ok: false,
            detail: `execute command disabled (aws ecs update-service --cluster ${cluster} --service ${service} --enable-execute-command --force-new-deployment)`,
          },
    );
    const task =
      target.task !== undefined
        ? await deps.ecs.describeTask(ecs, cluster, target.task)
        : (await deps.ecs.fetchTasks(ecs, cluster, service))[0];
    if (task === undefined || task === null) {
      const detail =
        target.task !== undefined
          ? `${target.task} not found in cluster "${cluster}"`
          : `no running tasks in ${service}`;
      checks.push({ name: 'Task', ok: false, detail });
      return checks;
    }
    checks.push(checkTask(task), checkAgent(task), await checkTaskRole(ctx, ecs, task, deps));
  } catch (err) {
    checks.push({
      name: checks.length === 0 ? serviceName : 'ECS Exec',
      ok: false,
      detail: describeAwsError(err, { profile: ctx.profile }).message,
    });
  }
  return checks;
}

export interface DoctorOptions {
  profile?: string;
  region?: string;
  /** `cluster/service` or `cluster/service/task-id` whose ECS Exec prerequisites to check. */
  ecs?: string;
}

export async function runDoctorChecks(opts: DoctorOptions, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const files = await deps.loadSharedConfig();
  const checks = [checkNode(deps.nodeVersion), await checkPlugin(deps), checkConfigFiles(files)];
  if (opts.profile) checks.push(await checkCredentials(opts.profile, files, deps));
  if (opts.ecs !== undefined) {
    if (!opts.profile) throw new CliError('--ecs needs --profile');
    const target = parseExecTarget(opts.ecs);
    if (target.cluster === undefined || target.service === undefined) {
      throw new CliError('--ecs takes cluster/service or cluster/service/task-id');
    }
    const region = resolveRegion({
      flag: opts.region,
      env: deps.env,
      profileRegion: profileRegion(files, opts.profile),
    });
    if (region === undefined) throw new CliError('--ecs needs a region: pass --region or set one in the profile');
    const ctx = await deps.resolveContext({ profile: opts.profile, region });
    checks.push(...(await ecsExecChecks(ctx, target, deps)));
  }
  return checks;
}

export function renderDoctorReport(checks: DoctorCheck[]): string {
  const mark = (check: DoctorCheck) => (check.ok ? (check.warning ? '!' : '✔') : '✘');
  return `${checks.map((check) => `${mark(check)} ${check.name}: ${check.detail}`).join('\n')}\n`;
}

/** Prints the environment report to stdout; exit code 1 if any check failed. */
export async function runDoctor(opts: DoctorOptions, deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  const checks = await runDoctorChecks(opts, deps);
  deps.writeStdout(renderDoctorReport(checks));
  return checks.every((check) => check.ok) ? 0 : 1;
}
