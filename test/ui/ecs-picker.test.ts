import { describe, expect, test } from 'vitest';
import type { ClusterRow, ServiceRow, TaskRow } from '../../src/aws/ecs.js';
import {
  buildClusterChoices,
  buildServiceChoices,
  buildTaskChoices,
  CLUSTER_COLUMNS,
  formatAge,
  matchesName,
  matchesTask,
  SERVICE_COLUMNS,
  TASK_COLUMNS,
} from '../../src/ui/ecs-picker.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const cluster = (over: Partial<ClusterRow> = {}): ClusterRow => ({
  name: 'prod',
  arn: 'arn:x/prod',
  status: 'ACTIVE',
  services: 3,
  runningTasks: 5,
  connectable: true,
  reason: null,
  ...over,
});
const service = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  name: 'api',
  running: 2,
  desired: 2,
  launchType: 'FARGATE',
  taskDefinition: 'api:42',
  execEnabled: true,
  standalone: false,
  connectable: true,
  reason: null,
  ...over,
});
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  taskId: A,
  arn: `arn:x/${A}`,
  cluster: 'prod',
  service: 'api',
  lastStatus: 'RUNNING',
  health: 'HEALTHY',
  launchType: 'FARGATE',
  startedAt: new Date('2026-11-08T00:00:00Z'),
  availabilityZone: 'ap-northeast-2a',
  execEnabled: true,
  taskDefinition: 'api:42',
  containers: [{ name: 'app', runtimeId: 'r1', lastStatus: 'RUNNING', agentStatus: 'RUNNING' }],
  agentStatus: 'RUNNING',
  connectable: true,
  reason: null,
  ...over,
});

describe('column sets', () => {
  test('have the agreed headers with Note last', () => {
    expect(CLUSTER_COLUMNS.map((c) => c.header)).toEqual(['Cluster', 'Status', 'Services', 'Running tasks', 'Note']);
    expect(SERVICE_COLUMNS.map((c) => c.header)).toEqual([
      'Service',
      'Running/Desired',
      'Launch type',
      'Task definition',
      'Exec',
      'Note',
    ]);
    expect(TASK_COLUMNS.map((c) => c.header)).toEqual([
      'Task Id',
      'Status',
      'Health',
      'Containers',
      'Exec agent',
      'Started',
      'Note',
    ]);
  });
});

describe('buildClusterChoices', () => {
  test('renders the counts and disables clusters that cannot be used', () => {
    const { header, choices } = buildClusterChoices([
      cluster(),
      cluster({ name: 'old', status: 'INACTIVE', runningTasks: 0, connectable: false, reason: 'inactive' }),
    ]);
    expect(header).toContain('Running tasks');
    expect(choices[0]?.name).toMatch(/^│ prod +│ ACTIVE +│ 3 +│ 5 +│ +│$/);
    expect(choices[0]?.disabled).toBeUndefined();
    expect(choices[1]?.name).toMatch(/^│ old +│ INACTIVE +│ 3 +│ 0 +│ inactive +│$/);
    expect(choices[1]?.disabled).toBe(true);
  });
});

describe('recent marks', () => {
  test('buildClusterChoices and buildServiceChoices mark recently used names with *', () => {
    const clusters = buildClusterChoices([cluster(), cluster({ name: 'staging' })], ['staging']).choices;
    expect(clusters[0]?.name).toMatch(/^│ prod +│/);
    expect(clusters[1]?.name).toMatch(/^│ \* staging +│/);
    const services = buildServiceChoices([service(), service({ name: 'worker' })], ['api']).choices;
    expect(services[0]?.name).toMatch(/^│ \* api +│/);
    expect(services[1]?.name).toMatch(/^│ worker +│/);
  });
});

describe('buildServiceChoices', () => {
  test('shows running/desired, exec on or off and the row for tasks without a service', () => {
    const { choices } = buildServiceChoices([
      service(),
      service({ name: 'worker', execEnabled: false, connectable: false, reason: 'exec disabled' }),
      service({
        name: '(no service)',
        standalone: true,
        desired: null,
        execEnabled: null,
        running: 1,
        taskDefinition: null,
      }),
    ]);
    expect(choices[0]?.name).toMatch(/^│ api +│ 2\/2 +│ FARGATE +│ api:42 +│ on +│ +│$/);
    expect(choices[1]?.name).toMatch(/│ off +│ exec disabled +│$/);
    expect(choices[1]?.disabled).toBe(true);
    expect(choices[2]?.name).toMatch(/^│ \(no service\) +│ 1\/- +│ FARGATE +│ +│ +│ +│$/);
  });
});

describe('buildTaskChoices', () => {
  const now = new Date('2026-11-08T03:30:00Z');

  test('lists the containers, the exec agent state and the age', () => {
    const { choices } = buildTaskChoices(
      [
        task(),
        task({
          taskId: B,
          health: null,
          containers: [
            { name: 'app', runtimeId: null, lastStatus: 'RUNNING', agentStatus: 'PENDING' },
            { name: 'sidecar', runtimeId: null, lastStatus: 'RUNNING', agentStatus: null },
          ],
          agentStatus: 'PENDING',
          connectable: false,
          reason: 'agent pending',
        }),
      ],
      now,
    );
    expect(choices[0]?.name).toMatch(new RegExp(`^│ ${A} │ RUNNING +│ HEALTHY +│ app +│ RUNNING +│ 3h 30m +│ +│$`));
    expect(choices[0]?.disabled).toBeUndefined();
    expect(choices[1]?.name).toMatch(/│ app, sidecar +│ PENDING +│ 3h 30m +│ agent pending +│$/);
    expect(choices[1]?.disabled).toBe(true);
  });

  test('shortens long container lists and shows an empty age without a start time', () => {
    const containers = ['web', 'proxy', 'log-router', 'metrics', 'init'].map((name) => ({
      name,
      runtimeId: null,
      lastStatus: 'RUNNING',
      agentStatus: 'RUNNING',
    }));
    const { choices } = buildTaskChoices([task({ containers, startedAt: null })], now);
    expect(choices[0]?.name).toMatch(/│ web, proxy, log-router,… +│ RUNNING +│ +│ +│$/);
    expect(choices[0]?.name).toContain('…');
  });
});

describe('formatAge', () => {
  test('shows the two largest units, seconds only under a minute', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    expect(formatAge(new Date('2026-11-08T11:59:30Z'), now)).toBe('30s');
    expect(formatAge(new Date('2026-11-08T11:15:00Z'), now)).toBe('45m');
    expect(formatAge(new Date('2026-11-08T08:30:00Z'), now)).toBe('3h 30m');
    expect(formatAge(new Date('2026-11-08T09:00:00Z'), now)).toBe('3h');
    expect(formatAge(new Date('2026-11-01T06:00:00Z'), now)).toBe('7d 6h');
  });
});

describe('matching', () => {
  test('matchesName is a case-insensitive substring match; the empty term matches everything', () => {
    expect(matchesName('Prod-Cluster', '')).toBe(true);
    expect(matchesName('Prod-Cluster', 'd-clu')).toBe(true);
    expect(matchesName('Prod-Cluster', 'staging')).toBe(false);
  });

  test('matchesTask looks at the task id, the container names and the task definition', () => {
    const t = task({ taskDefinition: 'Api:42' });
    expect(matchesTask(t, '')).toBe(true);
    expect(matchesTask(t, 'AAAA')).toBe(true);
    expect(matchesTask(t, 'app')).toBe(true);
    expect(matchesTask(t, 'api:4')).toBe(true);
    expect(matchesTask(t, 'nope')).toBe(false);
  });
});
