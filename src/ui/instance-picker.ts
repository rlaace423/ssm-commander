import { CliError } from '../errors.js';
import type { InstanceRow } from '../types.js';
import { promptIo, requireTty } from './prompts.js';
import { createTable, markRecent, type TableColumn } from './table.js';
import { type TableChoice, tableSearch } from './table-search.js';

export const INSTANCE_COLUMNS: TableColumn[] = [
  { key: 'name', header: 'Name' },
  { key: 'instanceId', header: 'Instance Id' },
  { key: 'state', header: 'State' },
  { key: 'ssm', header: 'SSM' },
  { key: 'instanceType', header: 'Type' },
  { key: 'privateIp', header: 'Private IP' },
  { key: 'publicIp', header: 'Public IP' },
  { key: 'reason', header: 'Note' },
];

export interface InstanceChoices {
  header: string;
  footer: string;
  choices: Array<TableChoice<InstanceRow>>;
}

export function buildInstanceChoices(rows: InstanceRow[], recentIds: string[]): InstanceChoices {
  const recent = new Set(recentIds);
  const table = createTable(INSTANCE_COLUMNS, rows, (row, key) => {
    const value = row[key as keyof InstanceRow];
    const text = value === null || value === undefined ? '' : String(value);
    return key === 'name' ? markRecent(text, recent.has(row.instanceId)) : text;
  });
  return {
    header: table.header,
    footer: table.footer,
    choices: table.lines.map(({ text, value }) => ({
      name: text,
      value,
      disabled: value.connectable ? undefined : true, // the reason is already in the Note column
    })),
  };
}

export function matchesTerm(row: InstanceRow, term: string): boolean {
  const needle = term.toLowerCase();
  if (needle.length === 0) return true;
  return [row.name, row.instanceId, row.privateIp, row.publicIp].some(
    (field) => field?.toLowerCase().includes(needle) ?? false,
  );
}

export async function pickInstance(
  rows: InstanceRow[],
  opts: { message: string; recentIds: string[] },
): Promise<InstanceRow> {
  if (rows.length === 0) throw new CliError('No instances found');
  requireTty();
  const { header, footer, choices } = buildInstanceChoices(rows, opts.recentIds);
  return tableSearch<InstanceRow>(
    {
      message: opts.message,
      header,
      footer,
      source: (term) => choices.filter((choice) => matchesTerm(choice.value, term ?? '')),
    },
    promptIo,
  );
}
