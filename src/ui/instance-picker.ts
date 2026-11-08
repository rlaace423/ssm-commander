import { CliError } from '../errors.js';
import type { InstanceRow } from '../types.js';
import { promptIo, promptTableWidth, requireTty, type TtyNeed } from './prompts.js';
import { createTable, markRecent, type TableColumn } from './table.js';
import { type TableChoice, tableSearch } from './table-search.js';

/** In a narrow terminal the IP and type columns go first (search still finds them); a long name is cut. */
export const INSTANCE_COLUMNS: TableColumn[] = [
  { key: 'name', header: 'Name', shrink: true },
  { key: 'instanceId', header: 'Instance Id' },
  { key: 'state', header: 'State' },
  { key: 'ssm', header: 'SSM' },
  { key: 'instanceType', header: 'Type', dropOrder: 2 },
  { key: 'privateIp', header: 'Private IP', dropOrder: 3 },
  { key: 'publicIp', header: 'Public IP', dropOrder: 1 },
  { key: 'reason', header: 'Note' },
];

/** Shared by every command that may open the instance table. */
export const PICK_INSTANCE_NEED: TtyNeed = { what: 'Picking an instance', hint: 'Pass the instance name or id' };

export interface InstanceChoices {
  header: string;
  footer: string;
  choices: Array<TableChoice<InstanceRow>>;
}

export function buildInstanceChoices(rows: InstanceRow[], recentIds: string[], maxWidth?: number): InstanceChoices {
  const recent = new Set(recentIds);
  const table = createTable(
    INSTANCE_COLUMNS,
    rows,
    (row, key) => {
      const value = row[key as keyof InstanceRow];
      const text = value === null || value === undefined ? '' : String(value);
      return key === 'name' ? markRecent(text, recent.has(row.instanceId)) : text;
    },
    { maxWidth },
  );
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
  requireTty(PICK_INSTANCE_NEED);
  const { header, footer, choices } = buildInstanceChoices(rows, opts.recentIds, promptTableWidth());
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
