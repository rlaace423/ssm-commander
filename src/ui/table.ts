import stringWidth from 'string-width';

export interface TableColumn {
  key: string;
  header: string;
  /** Dropped, lowest number first, while the table is wider than the limit; columns without it always stay. */
  dropOrder?: number;
  /** Cut with an ellipsis to make the table fit once every droppable column is gone. */
  shrink?: boolean;
}

export interface TableOptions {
  /** Display width the whole table (borders included) should not exceed; omitted means unlimited. */
  maxWidth?: number;
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
/** A shrunk column keeps at least this many characters so the row stays recognisable. */
const MIN_SHRINK_WIDTH = 8;
/** Below this the table drops every optional column anyway; narrower limits only cut the shrink column further. */
const MIN_TABLE_WIDTH = 20;

/** Prefix of the first cell of rows the history knows (recent connections). */
export const RECENT_MARK = '*';

export function markRecent(text: string, recent: boolean): string {
  return recent ? `${RECENT_MARK} ${text}` : text;
}

type Border = { left: string; mid: string; right: string; fill: string };

function cellText(text: string, width: number): string {
  const fill = ' '.repeat(Math.max(0, width - stringWidth(text)));
  return `${' '.repeat(CELL_PADDING)}${text}${fill}${' '.repeat(CELL_PADDING)}${TABLE_STYLE.vertical}`;
}

/** Cuts `text` to `width` display columns, ending in an ellipsis when something was removed. */
export function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let kept = '';
  for (const char of text) {
    if (stringWidth(kept + char) + 1 > width) break;
    kept += char;
  }
  return `${kept}…`;
}

/** The width a table takes for a terminal of `columns`, minus the prompt's own indent; undefined without a terminal. */
export function terminalTableWidth(stream: { columns?: number }, overhead: number): number | undefined {
  return stream.columns === undefined ? undefined : Math.max(MIN_TABLE_WIDTH, stream.columns - overhead);
}

function measure(columns: TableColumn[], cells: string[][]): number[] {
  return columns.map((column, i) =>
    Math.max(stringWidth(column.header), ...cells.map((values) => stringWidth(values[i] ?? ''))),
  );
}

/** Borders included: one leading vertical, then padding, text and a vertical per column. */
function totalWidth(widths: number[]): number {
  return widths.reduce((sum, w) => sum + w + CELL_PADDING * 2 + 1, 1);
}

/**
 * Columns and cell texts that fit `maxWidth`: droppable columns go first (lowest dropOrder first), then the
 * shrink column is cut, but never below MIN_SHRINK_WIDTH, so a very narrow terminal still gets a readable table.
 */
function fitColumns<T>(
  columns: TableColumn[],
  rows: T[],
  cell: (row: T, key: string) => string,
  maxWidth: number | undefined,
): { columns: TableColumn[]; cells: string[][]; widths: number[] } {
  let kept = columns;
  let cells = rows.map((row) => kept.map((column) => cell(row, column.key)));
  let widths = measure(kept, cells);
  if (maxWidth === undefined) return { columns: kept, cells, widths };

  const droppable = kept
    .filter((column) => column.dropOrder !== undefined)
    .sort((a, b) => (a.dropOrder ?? 0) - (b.dropOrder ?? 0));
  for (const column of droppable) {
    if (totalWidth(widths) <= maxWidth) break;
    kept = kept.filter((c) => c !== column);
    cells = rows.map((row) => kept.map((c) => cell(row, c.key)));
    widths = measure(kept, cells);
  }

  const overflow = totalWidth(widths) - maxWidth;
  const index = kept.findIndex((column) => column.shrink);
  if (overflow > 0 && index !== -1) {
    const column = kept[index] as TableColumn;
    const floor = Math.max(MIN_SHRINK_WIDTH, stringWidth(column.header));
    const target = Math.max(floor, (widths[index] ?? 0) - overflow);
    widths[index] = target;
    cells = cells.map((values) => values.map((value, i) => (i === index ? truncate(value, target) : value)));
  }
  return { columns: kept, cells, widths };
}

/** Renders a box-drawing table whose column widths are measured by display width (wide characters count as 2). */
export function createTable<T>(
  allColumns: TableColumn[],
  rows: T[],
  cell: (row: T, key: string) => string,
  opts: TableOptions = {},
): Table<T> {
  const { columns, cells, widths } = fitColumns(allColumns, rows, cell, opts.maxWidth);
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
