import { select } from '@inquirer/prompts';
import type { ClusterRow, ContainerInfo, ServiceRow, TaskRow } from '../aws/ecs.js';
import { CliError } from '../errors.js';
import { promptIo, promptTableWidth, requireTty } from './prompts.js';
import { createTable, markRecent, type TableColumn } from './table.js';
import { type TableChoice, tableSearch } from './table-search.js';

/** dropOrder: what a narrow terminal loses first; the name, the status and the Note (the reason) always stay. */
export const CLUSTER_COLUMNS: TableColumn[] = [
  { key: 'name', header: 'Cluster', shrink: true },
  { key: 'status', header: 'Status' },
  { key: 'services', header: 'Services', dropOrder: 2 },
  { key: 'runningTasks', header: 'Running tasks', dropOrder: 1 },
  { key: 'reason', header: 'Note' },
];

export const SERVICE_COLUMNS: TableColumn[] = [
  { key: 'name', header: 'Service', shrink: true },
  { key: 'tasks', header: 'Running/Desired' },
  { key: 'launchType', header: 'Launch type', dropOrder: 2 },
  { key: 'taskDefinition', header: 'Task definition', dropOrder: 1 },
  { key: 'execEnabled', header: 'Exec' },
  { key: 'reason', header: 'Note' },
];

export const TASK_COLUMNS: TableColumn[] = [
  { key: 'taskId', header: 'Task Id' },
  { key: 'lastStatus', header: 'Status' },
  { key: 'health', header: 'Health', dropOrder: 2 },
  { key: 'containers', header: 'Containers', dropOrder: 3 },
  { key: 'agentStatus', header: 'Exec agent' },
  { key: 'startedAt', header: 'Started', dropOrder: 1 },
  { key: 'reason', header: 'Note' },
];

const CONTAINERS_WIDTH = 24;

export interface Choices<T> {
  header: string;
  footer: string;
  choices: Array<TableChoice<T>>;
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

function toChoices<T extends { connectable: boolean }>(
  columns: TableColumn[],
  rows: T[],
  cell: (row: T, key: string) => string,
  maxWidth?: number,
): Choices<T> {
  const table = createTable(columns, rows, cell, { maxWidth });
  return {
    header: table.header,
    footer: table.footer,
    choices: table.lines.map(({ text: name, value }) => ({
      name,
      value,
      disabled: value.connectable ? undefined : true, // the reason is already in the Note column
    })),
  };
}

/** Age as the two largest of days/hours/minutes; seconds only under a minute. */
export function formatAge(started: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const units = [
    [days, 'd'],
    [hours, 'h'],
    [minutes, 'm'],
  ] as const;
  const first = units.findIndex(([n]) => n > 0);
  if (first === -1) return `${seconds}s`;
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n}${unit}`)
    .join(' ');
}

/** Names the history knows (recent clusters, or recent services of the shown cluster) get the `*` mark. */
export interface PickOptions {
  recent: string[];
}

export function buildClusterChoices(rows: ClusterRow[], recent: string[] = [], maxWidth?: number): Choices<ClusterRow> {
  const marked = new Set(recent);
  return toChoices(
    CLUSTER_COLUMNS,
    rows,
    (row, key) => (key === 'name' ? markRecent(row.name, marked.has(row.name)) : text(row[key as keyof ClusterRow])),
    maxWidth,
  );
}

export function buildServiceChoices(rows: ServiceRow[], recent: string[] = [], maxWidth?: number): Choices<ServiceRow> {
  const marked = new Set(recent);
  return toChoices(
    SERVICE_COLUMNS,
    rows,
    (row, key) => {
      switch (key) {
        case 'name':
          return markRecent(row.name, marked.has(row.name));
        case 'tasks':
          return `${row.running}/${row.desired ?? '-'}`;
        case 'execEnabled':
          return row.execEnabled === null ? '' : row.execEnabled ? 'on' : 'off';
        default:
          return text(row[key as keyof ServiceRow]);
      }
    },
    maxWidth,
  );
}

export function buildTaskChoices(rows: TaskRow[], now: Date, maxWidth?: number): Choices<TaskRow> {
  return toChoices(
    TASK_COLUMNS,
    rows,
    (row, key) => {
      switch (key) {
        case 'containers': {
          const names = row.containers.map((c) => c.name).join(', ');
          return names.length > CONTAINERS_WIDTH ? `${names.slice(0, CONTAINERS_WIDTH - 1)}…` : names;
        }
        case 'startedAt':
          return row.startedAt ? formatAge(row.startedAt, now) : '';
        default:
          return text(row[key as keyof TaskRow]);
      }
    },
    maxWidth,
  );
}

export function matchesName(name: string, term: string): boolean {
  return term.length === 0 || name.toLowerCase().includes(term.toLowerCase());
}

export function matchesTask(row: TaskRow, term: string): boolean {
  const needle = term.toLowerCase();
  if (needle.length === 0) return true;
  return [row.taskId, row.taskDefinition ?? '', ...row.containers.map((c) => c.name)].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export async function pickCluster(rows: ClusterRow[], opts: PickOptions = { recent: [] }): Promise<ClusterRow> {
  if (rows.length === 0) throw new CliError('No ECS clusters found');
  requireTty({ what: 'Picking a cluster', hint: 'Pass --cluster' });
  const { header, footer, choices } = buildClusterChoices(rows, opts.recent, promptTableWidth());
  return tableSearch<ClusterRow>(
    {
      message: 'Select a cluster',
      header,
      footer,
      source: (term) => choices.filter((choice) => matchesName(choice.value.name, term ?? '')),
    },
    promptIo,
  );
}

export async function pickService(
  rows: ServiceRow[],
  cluster: string,
  opts: PickOptions = { recent: [] },
): Promise<ServiceRow> {
  if (rows.length === 0) throw new CliError(`No services or running tasks in cluster "${cluster}"`);
  requireTty({ what: 'Picking a service', hint: 'Pass cluster/service as the target, or --service' });
  const { header, footer, choices } = buildServiceChoices(rows, opts.recent, promptTableWidth());
  return tableSearch<ServiceRow>(
    {
      message: `Select a service in ${cluster}`,
      header,
      footer,
      source: (term) => choices.filter((choice) => matchesName(choice.value.name, term ?? '')),
    },
    promptIo,
  );
}

export async function pickTask(rows: TaskRow[], service: string, now: Date = new Date()): Promise<TaskRow> {
  if (rows.length === 0) throw new CliError(`No running tasks in ${service}`);
  requireTty({ what: 'Picking a task', hint: 'Pass --task' });
  const { header, footer, choices } = buildTaskChoices(rows, now, promptTableWidth());
  return tableSearch<TaskRow>(
    {
      message: `Select a task of ${service}`,
      header,
      footer,
      source: (term) => choices.filter((choice) => matchesTask(choice.value, term ?? '')),
    },
    promptIo,
  );
}

/** Only asked when a task has several containers; containers without a running exec agent cannot be chosen. */
export async function pickContainer(task: TaskRow): Promise<ContainerInfo> {
  requireTty({ what: 'Picking a container', hint: 'Pass --container' });
  return select<ContainerInfo>(
    {
      message: `Select a container of task ${task.taskId}`,
      choices: task.containers.map((container) => ({
        name: container.name,
        value: container,
        description: `${container.lastStatus ?? 'unknown'}, exec agent ${container.agentStatus ?? 'none'}`,
        disabled: container.agentStatus === 'RUNNING' ? false : `(exec agent ${container.agentStatus ?? 'none'})`,
      })),
    },
    promptIo,
  );
}
