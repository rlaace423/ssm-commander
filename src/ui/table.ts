import stringWidth from 'string-width';

export interface TableColumn {
  key: string;
  header: string;
}

export interface Table<T> {
  header: string;
  footer: string;
  lines: Array<{ text: string; value: T }>;
}

export const TABLE_STYLE = {
  headerTop: { left: '┌', mid: '┬', right: '┐', fill: '─' },
  headerBottom: { left: '├', mid: '┼', right: '┤', fill: '─' },
  tableBottom: { left: '└', mid: '┴', right: '┘', fill: '─' },
  vertical: '│',
} as const;

const CELL_PADDING = 1;

type Border = { left: string; mid: string; right: string; fill: string };

function cellText(text: string, width: number): string {
  const fill = ' '.repeat(Math.max(0, width - stringWidth(text)));
  return `${' '.repeat(CELL_PADDING)}${text}${fill}${' '.repeat(CELL_PADDING)}${TABLE_STYLE.vertical}`;
}

/** Renders a box-drawing table whose column widths are measured by display width (wide characters count as 2). */
export function createTable<T>(columns: TableColumn[], rows: T[], cell: (row: T, key: string) => string): Table<T> {
  const cells = rows.map((row) => columns.map((column) => cell(row, column.key)));
  const widths = columns.map((column, i) =>
    Math.max(stringWidth(column.header), ...cells.map((values) => stringWidth(values[i] ?? ''))),
  );
  const border = (b: Border) =>
    `${b.left}${widths.map((w) => b.fill.repeat(w + CELL_PADDING * 2)).join(b.mid)}${b.right}`;
  const line = (values: string[]) =>
    `${TABLE_STYLE.vertical}${values.map((value, i) => cellText(value, widths[i] ?? 0)).join('')}`;

  return {
    header: [
      border(TABLE_STYLE.headerTop),
      line(columns.map((column) => column.header)),
      border(TABLE_STYLE.headerBottom),
    ].join('\n'),
    footer: border(TABLE_STYLE.tableBottom),
    lines: rows.map((row, i) => ({ text: line(cells[i] ?? []), value: row })),
  };
}

/** The first cell of a rendered table line (used as the short answer once a row is chosen). */
export function firstCell(line: string): string {
  const cells = line
    .split(TABLE_STYLE.vertical)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return cells[0] ?? line.trim();
}
