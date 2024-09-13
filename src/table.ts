import type { Table } from './interface.ts';

export const DEFAULT_TABLE_STYLE = {
  headerTop: {
    left: '┌',
    mid: '┬',
    right: '┐',
    default: '─',
  },
  headerBottom: {
    left: '├',
    mid: '┼',
    right: '┤',
    default: '─',
  },
  tableBottom: {
    left: '└',
    mid: '┴',
    right: '┘',
    default: '─',
  },
  vertical: '│',
};
const CELL_PADDING = 1;
const MARGIN_LEFT = '  ';

// text.length must be less than or equal to size
function drawCell(text: string, size: number): string {
  return (
    ' '.repeat(CELL_PADDING) +
    text +
    ' '.repeat(size - text.length) +
    ' '.repeat(CELL_PADDING) +
    DEFAULT_TABLE_STYLE.vertical
  );
}

function calculateMaxLength(
  fields: string[],
  contents: Array<Record<string, any>>,
  headerNames: string[],
): Record<string, number> {
  const maxLength: Record<string, any> = {};
  for (const field of fields) {
    maxLength[field] = 0;
  }

  for (const content of contents) {
    for (const field of fields) {
      if ((content[field] ?? '').length > maxLength[field]) {
        maxLength[field] = (content[field] ?? '').length;
      }
    }
  }

  for (let i = 0; i < fields.length; i = i + 1) {
    const field = fields[i];
    maxLength[field] = headerNames[i].length > maxLength[field] ? headerNames[i].length : maxLength[field];
  }

  return maxLength;
}

function drawTableLine(fields: string[], maxLength: Record<string, number>, charSet: Record<string, string>): string {
  let result = charSet.left;
  result += fields.map((field) => charSet.default.repeat(maxLength[field] + CELL_PADDING * 2)).join(charSet.mid);
  result += charSet.right + '\n';
  return result;
}

export function createTable(fields: string[], contents: Array<Record<string, any>>, customHeaderNames?: string[]): Table {
  const headerNames = customHeaderNames ?? fields;
  const maxLength = calculateMaxLength(fields, contents, headerNames);

  // ┌─────┬─────┬─────┬─────┐
  let header = MARGIN_LEFT + drawTableLine(fields, maxLength, DEFAULT_TABLE_STYLE.headerTop);
  // │ headerNames[0] │ headerNames[1] │ headerNames[1] │ ... │
  header += MARGIN_LEFT + DEFAULT_TABLE_STYLE.vertical;
  header += [...headerNames.map((name, index) => drawCell(name, maxLength[fields[index]])), '\n'].join('');
  // ├─────┼─────┼─────┼─────┤
  header += MARGIN_LEFT + drawTableLine(fields, maxLength, DEFAULT_TABLE_STYLE.headerBottom);

  // └─────┴─────┴─────┴─────┘
  const footer = '\n' + MARGIN_LEFT + drawTableLine(fields, maxLength, DEFAULT_TABLE_STYLE.tableBottom);

  const bodies = contents.map((content) => ({
    name: [
      DEFAULT_TABLE_STYLE.vertical,
      ...fields.map((field) => drawCell(content[field] ?? '', maxLength[field])),
    ].join(''),
    value: content,
  }));

  return { header, footer, bodies };
}
