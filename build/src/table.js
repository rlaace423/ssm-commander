"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TABLE_STYLE = void 0;
exports.createTable = createTable;
exports.DEFAULT_TABLE_STYLE = {
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
function drawCell(text, size) {
    return (' '.repeat(CELL_PADDING) +
        text +
        ' '.repeat(size - text.length) +
        ' '.repeat(CELL_PADDING) +
        exports.DEFAULT_TABLE_STYLE.vertical);
}
function calculateMaxLength(fields, contents, headerNames) {
    const maxLength = {};
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
function drawTableLine(fields, maxLength, charSet) {
    let result = charSet.left;
    result += fields.map((field) => charSet.default.repeat(maxLength[field] + CELL_PADDING * 2)).join(charSet.mid);
    result += charSet.right + '\n';
    return result;
}
function createTable(fields, contents, customHeaderNames) {
    const headerNames = customHeaderNames ?? fields;
    const maxLength = calculateMaxLength(fields, contents, headerNames);
    let header = MARGIN_LEFT + drawTableLine(fields, maxLength, exports.DEFAULT_TABLE_STYLE.headerTop);
    header += MARGIN_LEFT + exports.DEFAULT_TABLE_STYLE.vertical;
    header += [...headerNames.map((name, index) => drawCell(name, maxLength[fields[index]])), '\n'].join('');
    header += MARGIN_LEFT + drawTableLine(fields, maxLength, exports.DEFAULT_TABLE_STYLE.headerBottom);
    const footer = '\n' + MARGIN_LEFT + drawTableLine(fields, maxLength, exports.DEFAULT_TABLE_STYLE.tableBottom);
    const bodies = contents.map((content) => ({
        name: [
            exports.DEFAULT_TABLE_STYLE.vertical,
            ...fields.map((field) => drawCell(content[field] ?? '', maxLength[field])),
        ].join(''),
        value: content,
    }));
    return { header, footer, bodies };
}
//# sourceMappingURL=table.js.map