import { createEcsClient } from '../aws/clients.js';
import {
  type ClusterRow,
  type ContainerInfo,
  describeTask,
  type ExecTarget,
  fetchClusters,
  fetchServices,
  fetchTasks,
  parseExecTarget,
  type ServiceRow,
  type ServiceSummary,
  STANDALONE_SERVICE,
  summarizeServices,
  type TaskRow,
  tasksOfService,
} from '../aws/ecs.js';
import { resolveContext } from '../context.js';
import { AccessDeniedError, CliError, describeAwsError, ECS_IAM_ACTIONS } from '../errors.js';
import { defaultRunExecDeps, type ExecSessionInput, runExecSession } from '../session/run-exec.js';
import type { AwsContext, Sender } from '../types.js';
import { pickCluster, pickContainer, pickService, pickTask } from '../ui/ecs-picker.js';
import { info, type Spinner, spinner } from '../ui/output.js';
import { requireTty } from '../ui/prompts.js';

export const DEFAULT_COMMAND = '/bin/sh';

export interface ExecOptions {
  profile?: string;
  region?: string;
  cluster?: string;
  service?: string;
  task?: string;
  container?: string;
  command?: string;
  connectable?: boolean;
}

export interface ExecDeps {
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  ecsClient: (ctx: AwsContext) => Promise<Sender>;
  fetchClusters: (ecs: Sender) => Promise<ClusterRow[]>;
  fetchServices: (ecs: Sender, cluster: string) => Promise<ServiceSummary[]>;
  fetchTasks: (ecs: Sender, cluster: string, service?: string) => Promise<TaskRow[]>;
  describeTask: (ecs: Sender, cluster: string, taskId: string) => Promise<TaskRow | null>;
  pickCluster: (rows: ClusterRow[]) => Promise<ClusterRow>;
  pickService: (rows: ServiceRow[], cluster: string) => Promise<ServiceRow>;
  pickTask: (rows: TaskRow[], service: string) => Promise<TaskRow>;
  pickContainer: (task: TaskRow) => Promise<ContainerInfo>;
  runExecSession: (ctx: AwsContext, input: ExecSessionInput) => Promise<number>;
  requireTty: () => void;
  info: (message: string) => void;
  spinner: (text: string) => Spinner;
}

export function defaultExecDeps(): ExecDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    ecsClient: (ctx) => createEcsClient(ctx),
    fetchClusters,
    fetchServices,
    fetchTasks,
    describeTask,
    pickCluster,
    pickService,
    pickTask: (rows, service) => pickTask(rows, service),
    pickContainer,
    runExecSession: async (ctx, input) => runExecSession(ctx, input, await defaultRunExecDeps(ctx)),
    requireTty: () => requireTty(),
    info,
    spinner,
  };
}

type Step = Pick<ExecDeps, 'spinner' | 'info'> & { profile: string };

/** Runs a listing behind a spinner; a denied call keeps its AccessDeniedError and gains the way around it. */
async function listing<T>(
  step: Step,
  text: string,
  action: string,
  skipHint: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const spin = step.spinner(text);
  try {
    const result = await fn();
    spin.stop();
    return result;
  } catch (err) {
    spin.fail(`${text.replace(/\.\.\.$/, '')} failed`);
    const described = describeAwsError(err, { profile: step.profile, action });
    if (described instanceof AccessDeniedError && skipHint !== null) {
      throw new AccessDeniedError(described.message, `${skipHint}. ${described.hint ?? ''}`.trim());
    }
    throw described;
  }
}

/** One choice is used without asking; `--connectable` narrows what the picker shows, never what a name resolves to. */
async function pickFrom<T extends { connectable: boolean }>(
  rows: T[],
  connectableOnly: boolean,
  pick: (rows: T[]) => Promise<T>,
  used: (row: T) => void,
): Promise<T> {
  const candidates = connectableOnly ? rows.filter((row) => row.connectable) : rows;
  if (candidates.length === 0) {
    throw new CliError(`No connectable choices (${rows.length} listed); run without --connectable to see them`);
  }
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    used(only);
    return only;
  }
  return pick(candidates);
}

async function chooseCluster(ecs: Sender, connectableOnly: boolean, step: Step, deps: ExecDeps): Promise<string> {
  const clusters = await listing(
    step,
    'Fetching clusters...',
    ECS_IAM_ACTIONS.listClusters,
    'Pass --cluster (with --task to skip every listing)',
    () => deps.fetchClusters(ecs),
  );
  if (clusters.length === 0) throw new CliError('No ECS clusters found');
  const chosen = await pickFrom(clusters, connectableOnly, deps.pickCluster, (row) =>
    step.info(`Using the only cluster "${row.name}"`),
  );
  return chosen.name;
}

async function findTask(
  ecs: Sender,
  cluster: string | undefined,
  taskId: string,
  connectableOnly: boolean,
  step: Step,
  deps: ExecDeps,
): Promise<TaskRow> {
  if (cluster !== undefined) {
    const row = await listing(step, 'Looking up the task...', ECS_IAM_ACTIONS.describeTasks, null, () =>
      deps.describeTask(ecs, cluster, taskId),
    );
    if (row === null) throw new CliError(`Task "${taskId}" was not found in cluster "${cluster}"`);
    return row;
  }
  const clusters = await listing(step, 'Fetching clusters...', ECS_IAM_ACTIONS.listClusters, 'Pass --cluster', () =>
    deps.fetchClusters(ecs),
  );
  const candidates = connectableOnly ? clusters.filter((c) => c.connectable) : clusters;
  for (const candidate of candidates) {
    const row = await listing(
      step,
      `Looking for the task in ${candidate.name}...`,
      ECS_IAM_ACTIONS.describeTasks,
      null,
      () => deps.describeTask(ecs, candidate.name, taskId),
    );
    if (row !== null) return row;
  }
  throw new CliError(
    `Task "${taskId}" was not found in any cluster`,
    'Pass --cluster if it lives in a cluster you cannot list',
  );
}

async function chooseTask(
  ecs: Sender,
  want: ExecTarget,
  connectableOnly: boolean,
  step: Step,
  deps: ExecDeps,
): Promise<TaskRow> {
  const cluster = want.cluster ?? (await chooseCluster(ecs, connectableOnly, step, deps));

  if (want.service !== undefined) {
    const service = want.service;
    const tasks = await listing(
      step,
      'Fetching tasks...',
      ECS_IAM_ACTIONS.listTasks,
      'Pass --task to connect without listing',
      async () =>
        service === STANDALONE_SERVICE
          ? tasksOfService(await deps.fetchTasks(ecs, cluster), STANDALONE_SERVICE)
          : deps.fetchTasks(ecs, cluster, service),
    );
    if (tasks.length === 0) throw new CliError(`No running tasks in service "${service}" of cluster "${cluster}"`);
    return pickFrom(
      tasks,
      connectableOnly,
      (rows) => deps.pickTask(rows, service),
      (row) => step.info(`Using the only task ${row.taskId} of service "${service}"`),
    );
  }

  const [services, tasks] = await listing(
    step,
    'Fetching services...',
    ECS_IAM_ACTIONS.listServices,
    'Pass --service, or --task to connect without listing',
    () => Promise.all([deps.fetchServices(ecs, cluster), deps.fetchTasks(ecs, cluster)]),
  );
  const rows = summarizeServices(services, tasks);
  if (rows.length === 0) throw new CliError(`No services or running tasks in cluster "${cluster}"`);
  const service = await pickFrom(
    rows,
    connectableOnly,
    (candidates) => deps.pickService(candidates, cluster),
    (row) => step.info(`Using the only service "${row.name}" in cluster "${cluster}"`),
  );
  const own = tasksOfService(tasks, service.name);
  if (own.length === 0) throw new CliError(`No running tasks in ${service.name}`);
  return pickFrom(
    own,
    connectableOnly,
    (candidates) => deps.pickTask(candidates, service.name),
    (row) => step.info(`Using the only task ${row.taskId} of service "${service.name}"`),
  );
}

async function chooseContainer(task: TaskRow, wanted: string | undefined, deps: ExecDeps): Promise<ContainerInfo> {
  const names = task.containers.map((c) => c.name).join(', ');
  if (wanted !== undefined) {
    const found = task.containers.find((c) => c.name === wanted);
    if (found === undefined) {
      throw new CliError(`Container "${wanted}" was not found in task ${task.taskId} (containers: ${names})`);
    }
    return found;
  }
  const only = task.containers[0];
  if (task.containers.length === 1 && only !== undefined) return only;
  if (task.containers.length === 0) throw new CliError(`Task ${task.taskId} has no containers`);
  return deps.pickContainer(task);
}

/**
 * Cluster → service → task → container, each step skipped when the command line or a single choice decides it,
 * then an interactive command in the container through ECS Exec. With --cluster and --task only DescribeTasks
 * and ExecuteCommand are called, which is what the AWS CLI itself needs.
 */
export async function runExec(
  target: string | undefined,
  opts: ExecOptions,
  deps: ExecDeps = defaultExecDeps(),
): Promise<number> {
  deps.requireTty(); // the session is interactive; fail before any AWS call
  const parsed: ExecTarget = target === undefined ? {} : parseExecTarget(target);
  const want: ExecTarget = {
    cluster: opts.cluster ?? parsed.cluster,
    service: opts.service ?? parsed.service,
    task: opts.task ?? parsed.task,
  };
  const command = opts.command ?? DEFAULT_COMMAND;
  const connectableOnly = opts.connectable === true;

  const ctx = await deps.resolveContext({ profile: opts.profile, region: opts.region });
  const ecs = await deps.ecsClient(ctx);
  const step: Step = { spinner: deps.spinner, info: deps.info, profile: ctx.profile };

  const task =
    want.task !== undefined
      ? await findTask(ecs, want.cluster, want.task, connectableOnly, step, deps)
      : await chooseTask(ecs, want, connectableOnly, step, deps);
  if (!task.connectable) throw new CliError(`Task ${task.taskId} cannot be reached: ${task.reason}`);

  const container = await chooseContainer(task, opts.container, deps);
  if (container.runtimeId === null) {
    throw new CliError(`Container "${container.name}" has no runtime id yet; the task may still be starting`);
  }

  deps.info(
    `Opening ${command} in ${container.name} of task ${task.taskId} (${task.service ?? 'no service'}, cluster ${task.cluster}) with profile ${ctx.profile}...`,
  );
  try {
    return await deps.runExecSession(ctx, {
      cluster: task.cluster,
      task: task.taskId,
      container: container.name,
      command,
      runtimeId: container.runtimeId,
    });
  } catch (err) {
    throw describeAwsError(err, { profile: ctx.profile, action: ECS_IAM_ACTIONS.execute });
  }
}
