import type { Task } from '@aws-sdk/client-ecs';
import { describe, expect, test, vi } from 'vitest';
import {
  buildExecTarget,
  describeTask,
  describeTaskDefinition,
  ecsEndpoint,
  executeCommand,
  fetchClusters,
  fetchServices,
  fetchTasks,
  isTaskId,
  parseExecTarget,
  type ServiceSummary,
  STANDALONE_SERVICE,
  sortRecentFirst,
  sortTasks,
  summarizeServices,
  taskIdFromArn,
  tasksOfService,
  toClusterRow,
  toTaskRow,
} from '../../src/aws/ecs.js';
import { CliError } from '../../src/errors.js';

const TASK_ID = '0123456789abcdef0123456789abcdef';
const TASK_ARN = `arn:aws:ecs:ap-northeast-2:123456789012:task/prod/${TASK_ID}`;

function task(over: Partial<Task> = {}): Task {
  return {
    taskArn: TASK_ARN,
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    healthStatus: 'HEALTHY',
    group: 'service:api',
    launchType: 'FARGATE',
    startedAt: new Date('2026-11-01T00:00:00Z'),
    availabilityZone: 'ap-northeast-2a',
    enableExecuteCommand: true,
    taskDefinitionArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:42',
    containers: [
      {
        name: 'app',
        runtimeId: `${TASK_ID}-1234`,
        lastStatus: 'RUNNING',
        managedAgents: [{ name: 'ExecuteCommandAgent', lastStatus: 'RUNNING' }],
      },
    ],
    ...over,
  };
}

const service = (over: Partial<ServiceSummary> = {}): ServiceSummary => ({
  name: 'api',
  arn: 'arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api',
  desired: 2,
  running: 2,
  launchType: 'FARGATE',
  taskDefinition: 'api:42',
  execEnabled: true,
  status: 'ACTIVE',
  ...over,
});

describe('parseExecTarget', () => {
  test('one segment is a service name unless it looks like a task id', () => {
    expect(parseExecTarget('api')).toEqual({ service: 'api' });
    expect(parseExecTarget(TASK_ID)).toEqual({ task: TASK_ID });
    expect(isTaskId(TASK_ID)).toBe(true);
    expect(isTaskId('api')).toBe(false);
  });

  test('two and three segments are cluster/service[/task]', () => {
    expect(parseExecTarget('prod/api')).toEqual({ cluster: 'prod', service: 'api' });
    expect(parseExecTarget(`prod/api/${TASK_ID}`)).toEqual({ cluster: 'prod', service: 'api', task: TASK_ID });
  });

  test('rejects empty segments and more than three segments', () => {
    expect(() => parseExecTarget('prod//api')).toThrow(CliError);
    expect(() => parseExecTarget('a/b/c/d')).toThrow(CliError);
  });
});

describe('identifiers', () => {
  test('taskIdFromArn takes the last path segment and leaves plain ids alone', () => {
    expect(taskIdFromArn(TASK_ARN)).toBe(TASK_ID);
    expect(taskIdFromArn(TASK_ID)).toBe(TASK_ID);
  });

  test('buildExecTarget and ecsEndpoint follow the AWS CLI', () => {
    expect(buildExecTarget('prod', TASK_ID, `${TASK_ID}-1234`)).toBe(`ecs:prod_${TASK_ID}_${TASK_ID}-1234`);
    expect(ecsEndpoint('ap-northeast-2')).toBe('https://ecs.ap-northeast-2.amazonaws.com');
  });
});

describe('toTaskRow', () => {
  test('a running task with exec enabled and a running agent is connectable', () => {
    const row = toTaskRow(task(), 'prod');
    expect(row).toMatchObject({
      taskId: TASK_ID,
      cluster: 'prod',
      service: 'api',
      lastStatus: 'RUNNING',
      health: 'HEALTHY',
      taskDefinition: 'api:42',
      agentStatus: 'RUNNING',
      connectable: true,
      reason: null,
    });
    expect(row.containers).toEqual([
      { name: 'app', runtimeId: `${TASK_ID}-1234`, lastStatus: 'RUNNING', agentStatus: 'RUNNING' },
    ]);
  });

  test('explains why a task cannot be reached', () => {
    expect(toTaskRow(task({ lastStatus: 'PENDING' }), 'prod').reason).toBe('pending');
    expect(toTaskRow(task({ enableExecuteCommand: false }), 'prod').reason).toBe('exec disabled');
    const pendingAgent = task({
      containers: [{ name: 'app', managedAgents: [{ name: 'ExecuteCommandAgent', lastStatus: 'PENDING' }] }],
    });
    expect(toTaskRow(pendingAgent, 'prod')).toMatchObject({ reason: 'agent pending', agentStatus: 'PENDING' });
    const noAgent = task({ containers: [{ name: 'app', managedAgents: [] }] });
    expect(toTaskRow(noAgent, 'prod')).toMatchObject({ reason: 'no exec agent', agentStatus: null });
  });

  test('carries the platform version and task definition arn for doctor', () => {
    const row = toTaskRow(task({ platformVersion: '1.4.0' }), 'prod');
    expect(row.platformVersion).toBe('1.4.0');
    expect(row.taskDefinitionArn).toBe('arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:42');
  });

  test('a task started outside a service has no service name', () => {
    expect(toTaskRow(task({ group: 'family:cron' }), 'prod').service).toBeNull();
  });
});

describe('summarizeServices and tasksOfService', () => {
  const rows = [
    toTaskRow(task(), 'prod'),
    toTaskRow(task({ taskArn: TASK_ARN.replace(/f$/, 'e'), enableExecuteCommand: false }), 'prod'),
    toTaskRow(task({ taskArn: TASK_ARN.replace(/f$/, 'd'), group: 'family:cron' }), 'prod'),
    toTaskRow(
      task({ taskArn: TASK_ARN.replace(/f$/, 'c'), group: 'service:worker', enableExecuteCommand: false }),
      'prod',
    ),
  ];

  test('builds one row per service plus one for tasks without a service, sorted by name', () => {
    const summary = summarizeServices([service({ name: 'worker', desired: 1, running: 1 }), service()], rows);
    expect(summary.map((s) => s.name)).toEqual(['api', 'worker', STANDALONE_SERVICE]);
    expect(summary[0]).toMatchObject({ running: 2, desired: 2, execEnabled: true, connectable: true, reason: null });
    expect(summary[1]).toMatchObject({ connectable: false, reason: 'exec disabled' });
    expect(summary[2]).toMatchObject({ standalone: true, running: 1, desired: null, connectable: true });
  });

  test('a service without running tasks is not connectable', () => {
    const summary = summarizeServices([service({ name: 'idle', running: 0, desired: 0 })], []);
    expect(summary[0]).toMatchObject({ connectable: false, reason: 'no running tasks' });
  });

  test('tasksOfService filters by service and the standalone pseudo-service', () => {
    expect(tasksOfService(rows, 'api').map((t) => t.taskId.slice(-1))).toEqual(['f', 'e']);
    expect(tasksOfService(rows, STANDALONE_SERVICE).map((t) => t.taskId.slice(-1))).toEqual(['d']);
  });

  test('sortTasks puts connectable tasks first, newest first', () => {
    const older = toTaskRow(
      task({ taskArn: TASK_ARN.replace(/f$/, 'a'), startedAt: new Date('2026-10-01T00:00:00Z') }),
      'prod',
    );
    const sorted = sortTasks([rows[1] as (typeof rows)[0], older, rows[0] as (typeof rows)[0]]);
    expect(sorted.map((t) => t.taskId.slice(-1))).toEqual(['f', 'a', 'e']);
  });
});

describe('sortRecentFirst', () => {
  test('puts the recently used names first in that order and keeps the rest in their order', () => {
    const rows = [{ name: 'api' }, { name: 'batch' }, { name: 'worker' }];
    expect(sortRecentFirst(rows, ['worker', 'gone', 'api', 'worker']).map((r) => r.name)).toEqual([
      'worker',
      'api',
      'batch',
    ]);
    expect(sortRecentFirst(rows, []).map((r) => r.name)).toEqual(['api', 'batch', 'worker']);
  });
});

describe('toClusterRow', () => {
  test('reports inactive clusters and clusters without running tasks', () => {
    const base = {
      clusterName: 'prod',
      clusterArn: 'arn:x/prod',
      status: 'ACTIVE',
      activeServicesCount: 3,
      runningTasksCount: 5,
    };
    expect(toClusterRow(base)).toMatchObject({
      name: 'prod',
      services: 3,
      runningTasks: 5,
      connectable: true,
      reason: null,
    });
    expect(toClusterRow({ ...base, status: 'PROVISIONING' })).toMatchObject({
      connectable: false,
      reason: 'provisioning',
    });
    expect(toClusterRow({ ...base, runningTasksCount: 0 })).toMatchObject({
      connectable: false,
      reason: 'no running tasks',
    });
  });
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

describe('fetchers', () => {
  test('fetchClusters pages ListClusters, describes in chunks and sorts by name', async () => {
    const arns = Array.from({ length: 101 }, (_, i) => `arn:x:cluster/c${String(i).padStart(3, '0')}`);
    const send = vi.fn(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListClustersCommand') {
        return cmd.input.nextToken === undefined
          ? { clusterArns: arns.slice(0, 100), nextToken: 't' }
          : { clusterArns: arns.slice(100) };
      }
      const requested = cmd.input.clusters as string[];
      return {
        clusters: requested.map((arn) => ({
          clusterArn: arn,
          clusterName: arn.split('/')[1],
          status: 'ACTIVE',
          runningTasksCount: 1,
          activeServicesCount: 1,
        })),
      };
    });
    const clusters = await fetchClusters({ send });
    expect(clusters).toHaveLength(101);
    expect(clusters[0]?.name).toBe('c000');
    const describeCalls = send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'DescribeClustersCommand');
    expect(describeCalls.map(([cmd]) => (cmd.input.clusters as string[]).length)).toEqual([100, 1]);
  });

  test('fetchServices lists then describes ten at a time', async () => {
    const arns = Array.from({ length: 12 }, (_, i) => `arn:x:service/prod/s${i}`);
    const send = vi.fn(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListServicesCommand') {
        expect(cmd.input.cluster).toBe('prod');
        return { serviceArns: arns };
      }
      const requested = cmd.input.services as string[];
      return {
        services: requested.map((arn) => ({
          serviceArn: arn,
          serviceName: arn.split('/').pop(),
          desiredCount: 1,
          runningCount: 1,
          launchType: 'FARGATE',
          taskDefinition: 'arn:x:task-definition/s:1',
          enableExecuteCommand: true,
          status: 'ACTIVE',
        })),
      };
    });
    const services = await fetchServices({ send }, 'prod');
    expect(services).toHaveLength(12);
    expect(services[0]).toMatchObject({ name: 's0', taskDefinition: 's:1', execEnabled: true });
    const describeCalls = send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'DescribeServicesCommand');
    expect(describeCalls.map(([cmd]) => (cmd.input.services as string[]).length)).toEqual([10, 2]);
  });

  test('fetchTasks passes the service filter and describes the listed tasks', async () => {
    const send = vi.fn(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListTasksCommand') {
        expect(cmd.input).toMatchObject({ cluster: 'prod', serviceName: 'api' });
        return { taskArns: [TASK_ARN] };
      }
      expect(cmd.input).toMatchObject({ cluster: 'prod', tasks: [TASK_ARN] });
      return { tasks: [task()] };
    });
    const tasks = await fetchTasks({ send }, 'prod', 'api');
    expect(tasks.map((t) => t.taskId)).toEqual([TASK_ID]);
  });

  test('fetchTasks returns an empty list without calling DescribeTasks when nothing is listed', async () => {
    const send = vi.fn(async () => ({ taskArns: [] }));
    expect(await fetchTasks({ send }, 'prod')).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('describeTask returns the row or null when the task does not exist', async () => {
    const send = vi.fn(async (cmd: Cmd) =>
      (cmd.input.tasks as string[])[0] === TASK_ID
        ? { tasks: [task()] }
        : { tasks: [], failures: [{ reason: 'MISSING' }] },
    );
    expect((await describeTask({ send }, 'prod', TASK_ID))?.taskId).toBe(TASK_ID);
    expect(await describeTask({ send }, 'prod', 'nope')).toBeNull();
  });

  test('executeCommand asks for an interactive session and maps the response', async () => {
    const send = vi.fn(async (cmd: Cmd) => {
      expect(cmd.constructor.name).toBe('ExecuteCommandCommand');
      expect(cmd.input).toEqual({
        cluster: 'prod',
        task: TASK_ID,
        container: 'app',
        interactive: true,
        command: '/bin/sh',
      });
      return {
        clusterArn: 'arn:x/prod',
        taskArn: TASK_ARN,
        containerName: 'app',
        session: { sessionId: 'ecs-1', streamUrl: 'wss://x', tokenValue: 'tok' },
      };
    });
    const result = await executeCommand(
      { send },
      { cluster: 'prod', task: TASK_ID, container: 'app', command: '/bin/sh' },
    );
    expect(result).toEqual({
      session: { SessionId: 'ecs-1', StreamUrl: 'wss://x', TokenValue: 'tok' },
      clusterArn: 'arn:x/prod',
      taskArn: TASK_ARN,
      containerName: 'app',
    });
  });

  test('describeTaskDefinition returns the roles and the init-process flag', async () => {
    const send = vi.fn(async (cmd: Cmd) => {
      expect(cmd.constructor.name).toBe('DescribeTaskDefinitionCommand');
      expect(cmd.input).toEqual({ taskDefinition: 'arn:td/api:42' });
      return {
        taskDefinition: {
          taskRoleArn: 'arn:role/task',
          executionRoleArn: 'arn:role/exec',
          containerDefinitions: [{ name: 'app', linuxParameters: { initProcessEnabled: true } }],
        },
      };
    });
    expect(await describeTaskDefinition({ send }, 'arn:td/api:42')).toEqual({
      taskRoleArn: 'arn:role/task',
      executionRoleArn: 'arn:role/exec',
      initProcessEnabled: true,
    });
    const bare = vi.fn(async () => ({ taskDefinition: { containerDefinitions: [{ name: 'app' }] } }));
    expect(await describeTaskDefinition({ send: bare }, 'x')).toEqual({
      taskRoleArn: null,
      executionRoleArn: null,
      initProcessEnabled: false,
    });
  });

  test('executeCommand rejects an incomplete session', async () => {
    const send = vi.fn(async () => ({ session: { sessionId: 'ecs-1' } }));
    await expect(
      executeCommand({ send }, { cluster: 'prod', task: TASK_ID, container: 'app', command: '/bin/sh' }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
