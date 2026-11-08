import type { Cluster, Task } from '@aws-sdk/client-ecs';
import { CliError } from '../errors.js';
import type { Sender, SessionStart } from '../types.js';

/** Pseudo-service under which tasks started outside a service (run-task, scheduled tasks) are listed. */
export const STANDALONE_SERVICE = '(no service)';
const EXEC_AGENT = 'ExecuteCommandAgent';
const TASK_ID = /^[0-9a-f]{32}$/;
const LIST_PAGE = 100;
const DESCRIBE_SERVICES_CHUNK = 10;
const DESCRIBE_CHUNK = 100;

export interface ExecTarget {
  cluster?: string;
  service?: string;
  task?: string;
}

export interface ClusterRow {
  name: string;
  arn: string;
  status: string;
  services: number;
  runningTasks: number;
  connectable: boolean;
  reason: string | null;
}

export interface ServiceSummary {
  name: string;
  arn: string | null;
  desired: number;
  running: number;
  launchType: string | null;
  taskDefinition: string | null;
  execEnabled: boolean;
  status: string;
}

export interface ServiceRow {
  name: string;
  running: number;
  desired: number | null;
  launchType: string | null;
  taskDefinition: string | null;
  execEnabled: boolean | null;
  standalone: boolean;
  connectable: boolean;
  reason: string | null;
}

export interface ContainerInfo {
  name: string;
  runtimeId: string | null;
  lastStatus: string | null;
  agentStatus: string | null;
}

export interface TaskRow {
  taskId: string;
  arn: string;
  cluster: string;
  service: string | null;
  lastStatus: string;
  health: string | null;
  launchType: string | null;
  /** Fargate platform version (ECS Exec needs 1.4.0 or newer); null on EC2. */
  platformVersion?: string | null;
  startedAt: Date | null;
  availabilityZone: string | null;
  execEnabled: boolean;
  taskDefinition: string | null;
  taskDefinitionArn?: string | null;
  containers: ContainerInfo[];
  agentStatus: string | null;
  connectable: boolean;
  reason: string | null;
}

/** Prefix that marks an ECS hop in `forward --target`, mirroring the plugin's own `ecs:` target format. */
export const ECS_TARGET_PREFIX = 'ecs:';

export function isEcsTarget(text: string): boolean {
  return text.startsWith(ECS_TARGET_PREFIX);
}

/** `ecs:service`, `ecs:cluster/service` or `ecs:cluster/service/taskId`. */
export function parseEcsTarget(text: string): ExecTarget {
  return parseExecTarget(text.slice(ECS_TARGET_PREFIX.length));
}

export function isTaskId(text: string): boolean {
  return TASK_ID.test(text);
}

/** `service`, `cluster/service` or `cluster/service/taskId`; a lone 32-hex-character segment is a task id. */
export function parseExecTarget(text: string): ExecTarget {
  const parts = text.split('/');
  if (parts.length > 3 || parts.some((part) => part.length === 0)) {
    throw new CliError(`Invalid target "${text}"`, 'Use service, cluster/service or cluster/service/task-id');
  }
  const [a, b, c] = parts;
  if (parts.length === 1) return isTaskId(a as string) ? { task: a } : { service: a };
  if (parts.length === 2) return { cluster: a, service: b };
  return { cluster: a, service: b, task: c };
}

/** Last path segment of an ARN (task id, cluster name, `family:revision`); plain values pass through. */
export function nameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf('/') + 1);
}

export const taskIdFromArn = nameFromArn;

export function buildExecTarget(cluster: string, taskId: string, runtimeId: string): string {
  return `ecs:${cluster}_${taskId}_${runtimeId}`;
}

/** The AWS CLI hands the plugin its ECS endpoint for execute-command sessions; we do the same. */
export function ecsEndpoint(region: string): string {
  return `https://ecs.${region}.amazonaws.com`;
}

export function toClusterRow(cluster: Cluster): ClusterRow {
  const status = cluster.status ?? 'UNKNOWN';
  const runningTasks = cluster.runningTasksCount ?? 0;
  const reason = status !== 'ACTIVE' ? status.toLowerCase() : runningTasks === 0 ? 'no running tasks' : null;
  return {
    name: cluster.clusterName ?? nameFromArn(cluster.clusterArn ?? ''),
    arn: cluster.clusterArn ?? '',
    status,
    services: cluster.activeServicesCount ?? 0,
    runningTasks,
    connectable: reason === null,
    reason,
  };
}

function taskReason(lastStatus: string, execEnabled: boolean, containers: ContainerInfo[]): string | null {
  if (lastStatus !== 'RUNNING') return lastStatus.toLowerCase();
  if (!execEnabled) return 'exec disabled';
  const statuses = containers.map((c) => c.agentStatus).filter((s): s is string => s !== null);
  if (statuses.length === 0) return 'no exec agent';
  if (!statuses.includes('RUNNING')) return `agent ${(statuses[0] as string).toLowerCase()}`;
  return null;
}

export function toTaskRow(task: Task, clusterName: string): TaskRow {
  const arn = task.taskArn ?? '';
  const group = task.group ?? '';
  const containers: ContainerInfo[] = (task.containers ?? []).map((c) => ({
    name: c.name ?? '',
    runtimeId: c.runtimeId ?? null,
    lastStatus: c.lastStatus ?? null,
    agentStatus: c.managedAgents?.find((agent) => agent.name === EXEC_AGENT)?.lastStatus ?? null,
  }));
  const lastStatus = task.lastStatus ?? 'UNKNOWN';
  const execEnabled = task.enableExecuteCommand === true;
  const agentStatuses = containers.map((c) => c.agentStatus).filter((s): s is string => s !== null);
  const reason = taskReason(lastStatus, execEnabled, containers);
  return {
    taskId: taskIdFromArn(arn),
    arn,
    cluster: clusterName,
    service: group.startsWith('service:') ? group.slice('service:'.length) : null,
    lastStatus,
    health: task.healthStatus ?? null,
    launchType: task.launchType ?? null,
    platformVersion: task.platformVersion ?? null,
    startedAt: task.startedAt ?? null,
    availabilityZone: task.availabilityZone ?? null,
    execEnabled,
    taskDefinition: task.taskDefinitionArn ? nameFromArn(task.taskDefinitionArn) : null,
    taskDefinitionArn: task.taskDefinitionArn ?? null,
    containers,
    agentStatus: agentStatuses.includes('RUNNING') ? 'RUNNING' : (agentStatuses[0] ?? null),
    connectable: reason === null,
    reason,
  };
}

export function tasksOfService(tasks: TaskRow[], service: string): TaskRow[] {
  return tasks.filter((t) => (service === STANDALONE_SERVICE ? t.service === null : t.service === service));
}

/** Connectable first, then newest first, so the task most likely wanted is at the top. */
/** Recently used names first, in that order, then the rest as given (names not in `rows` are ignored). */
export function sortRecentFirst<T extends { name: string }>(rows: T[], recent: string[]): T[] {
  const first = [...new Set(recent)]
    .map((name) => rows.find((row) => row.name === name))
    .filter((row): row is T => row !== undefined);
  return [...first, ...rows.filter((row) => !first.includes(row))];
}

export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  const time = (t: TaskRow) => t.startedAt?.getTime() ?? 0;
  return [...tasks].sort(
    (a, b) => Number(b.connectable) - Number(a.connectable) || time(b) - time(a) || a.taskId.localeCompare(b.taskId),
  );
}

function mostCommonReason(tasks: TaskRow[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.reason ?? '', (counts.get(t.reason ?? '') ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'not connectable';
}

/** One row per service, plus one for tasks that belong to no service; reachability comes from the tasks. */
export function summarizeServices(services: ServiceSummary[], tasks: TaskRow[]): ServiceRow[] {
  const rows: ServiceRow[] = services
    .map((s) => {
      const own = tasksOfService(tasks, s.name);
      const reason =
        own.length === 0 ? 'no running tasks' : own.some((t) => t.connectable) ? null : mostCommonReason(own);
      return {
        name: s.name,
        running: s.running,
        desired: s.desired,
        launchType: s.launchType ?? own[0]?.launchType ?? null,
        taskDefinition: s.taskDefinition,
        execEnabled: s.execEnabled,
        standalone: false,
        connectable: reason === null,
        reason,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const standalone = tasksOfService(tasks, STANDALONE_SERVICE);
  if (standalone.length > 0) {
    const reason = standalone.some((t) => t.connectable) ? null : mostCommonReason(standalone);
    rows.push({
      name: STANDALONE_SERVICE,
      running: standalone.length,
      desired: null,
      launchType: standalone[0]?.launchType ?? null,
      taskDefinition: null,
      execEnabled: null,
      standalone: true,
      connectable: reason === null,
      reason,
    });
  }
  return rows;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function fetchClusters(ecs: Sender): Promise<ClusterRow[]> {
  const { DescribeClustersCommand, ListClustersCommand } = await import('@aws-sdk/client-ecs');
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ecs.send(new ListClustersCommand({ maxResults: LIST_PAGE, nextToken }));
    arns.push(...(page.clusterArns ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  const rows: ClusterRow[] = [];
  for (const group of chunk(arns, DESCRIBE_CHUNK)) {
    const described = await ecs.send(new DescribeClustersCommand({ clusters: group }));
    rows.push(...(described.clusters ?? []).map(toClusterRow));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchServices(ecs: Sender, cluster: string): Promise<ServiceSummary[]> {
  const { DescribeServicesCommand, ListServicesCommand } = await import('@aws-sdk/client-ecs');
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ecs.send(new ListServicesCommand({ cluster, maxResults: LIST_PAGE, nextToken }));
    arns.push(...(page.serviceArns ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  const summaries: ServiceSummary[] = [];
  for (const group of chunk(arns, DESCRIBE_SERVICES_CHUNK)) {
    const described = await ecs.send(new DescribeServicesCommand({ cluster, services: group }));
    for (const s of described.services ?? []) {
      summaries.push({
        name: s.serviceName ?? nameFromArn(s.serviceArn ?? ''),
        arn: s.serviceArn ?? null,
        desired: s.desiredCount ?? 0,
        running: s.runningCount ?? 0,
        launchType: s.launchType ?? null,
        taskDefinition: s.taskDefinition ? nameFromArn(s.taskDefinition) : null,
        execEnabled: s.enableExecuteCommand === true,
        status: s.status ?? 'UNKNOWN',
      });
    }
  }
  return summaries;
}

/** Tasks with desired status RUNNING in the cluster, optionally only those of one service. */
export async function fetchTasks(ecs: Sender, cluster: string, service?: string): Promise<TaskRow[]> {
  const { DescribeTasksCommand, ListTasksCommand } = await import('@aws-sdk/client-ecs');
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ecs.send(
      new ListTasksCommand({ cluster, serviceName: service, maxResults: LIST_PAGE, nextToken }),
    );
    arns.push(...(page.taskArns ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  const rows: TaskRow[] = [];
  for (const group of chunk(arns, DESCRIBE_CHUNK)) {
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: group }));
    rows.push(...(described.tasks ?? []).map((t: Task) => toTaskRow(t, cluster)));
  }
  return sortTasks(rows);
}

export async function describeTask(ecs: Sender, cluster: string, taskId: string): Promise<TaskRow | null> {
  const { DescribeTasksCommand } = await import('@aws-sdk/client-ecs');
  const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskId] }));
  const task = described.tasks?.[0];
  return task ? toTaskRow(task, cluster) : null;
}

export interface TaskDefinitionSummary {
  taskRoleArn: string | null;
  executionRoleArn: string | null;
  /** Recommended for ECS Exec so the agent's child processes are reaped. */
  initProcessEnabled: boolean;
}

export async function describeTaskDefinition(ecs: Sender, taskDefinition: string): Promise<TaskDefinitionSummary> {
  const { DescribeTaskDefinitionCommand } = await import('@aws-sdk/client-ecs');
  const response = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition }));
  const definition = response?.taskDefinition ?? {};
  const containers: Array<{ linuxParameters?: { initProcessEnabled?: boolean } }> =
    definition.containerDefinitions ?? [];
  return {
    taskRoleArn: definition.taskRoleArn ?? null,
    executionRoleArn: definition.executionRoleArn ?? null,
    initProcessEnabled: containers.some((c) => c.linuxParameters?.initProcessEnabled === true),
  };
}

export interface ExecInput {
  cluster: string;
  task: string;
  container: string;
  command: string;
}

export interface ExecStart {
  session: SessionStart;
  clusterArn: string;
  taskArn: string;
  containerName: string;
}

export async function executeCommand(ecs: Sender, input: ExecInput): Promise<ExecStart> {
  const { ExecuteCommandCommand } = await import('@aws-sdk/client-ecs');
  const response = await ecs.send(new ExecuteCommandCommand({ ...input, interactive: true }));
  const { sessionId, streamUrl, tokenValue } = response?.session ?? {};
  if (!sessionId || !streamUrl || !tokenValue) {
    throw new CliError('ExecuteCommand returned an incomplete response');
  }
  return {
    session: { SessionId: sessionId, StreamUrl: streamUrl, TokenValue: tokenValue },
    clusterArn: response.clusterArn ?? '',
    taskArn: response.taskArn ?? input.task,
    containerName: response.containerName ?? input.container,
  };
}
