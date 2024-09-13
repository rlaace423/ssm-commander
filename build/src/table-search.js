"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prompt = void 0;
const core_1 = require("@inquirer/core");
const yoctocolors_cjs_1 = __importDefault(require("yoctocolors-cjs"));
const figures_1 = __importDefault(require("@inquirer/figures"));
const table_1 = require("./table");
const searchTheme = {
    icon: { cursor: figures_1.default.pointer },
    style: {
        disabled: (text) => yoctocolors_cjs_1.default.dim(`- ${text}`),
        searchTerm: (text) => yoctocolors_cjs_1.default.cyan(text),
        description: (text) => yoctocolors_cjs_1.default.cyan(text),
    },
    helpMode: 'auto',
};
function isSelectable(item) {
    return !core_1.Separator.isSeparator(item) && !item.disabled;
}
exports.prompt = (0, core_1.createPrompt)((config, done) => {
    const { pageSize = 7 } = config;
    const theme = (0, core_1.makeTheme)(searchTheme, config.theme);
    const firstRender = (0, core_1.useRef)(true);
    const [status, setStatus] = (0, core_1.useState)('searching');
    const [searchTerm, setSearchTerm] = (0, core_1.useState)('');
    const [searchResults, setSearchResults] = (0, core_1.useState)([]);
    const [searchError, setSearchError] = (0, core_1.useState)();
    const isLoading = status === 'loading' || status === 'searching';
    const prefix = (0, core_1.usePrefix)({ isLoading, theme });
    const bounds = (0, core_1.useMemo)(() => {
        const first = searchResults.findIndex(isSelectable);
        const last = searchResults.findLastIndex(isSelectable);
        return { first, last };
    }, [searchResults]);
    const [active = bounds.first, setActive] = (0, core_1.useState)();
    (0, core_1.useEffect)(() => {
        const controller = new AbortController();
        setStatus('searching');
        setSearchError(undefined);
        const fetchResults = async () => {
            try {
                const results = await config.source(searchTerm || undefined, {
                    signal: controller.signal,
                });
                if (!controller.signal.aborted) {
                    setActive(undefined);
                    setSearchError(undefined);
                    setSearchResults(results);
                    setStatus('pending');
                }
            }
            catch (error) {
                if (!controller.signal.aborted && error instanceof Error) {
                    setSearchError(error.message);
                }
            }
        };
        void fetchResults();
        return () => {
            controller.abort();
        };
    }, [searchTerm]);
    const selectedChoice = searchResults[active];
    (0, core_1.useKeypress)((key, rl) => {
        if ((0, core_1.isEnterKey)(key) && selectedChoice) {
            setStatus('done');
            done(selectedChoice.value);
        }
        else if (status !== 'searching' && (key.name === 'up' || key.name === 'down')) {
            rl.clearLine(0);
            if ((key.name === 'up' && active !== bounds.first) || (key.name === 'down' && active !== bounds.last)) {
                const offset = key.name === 'up' ? -1 : 1;
                let next = active;
                do {
                    next = (next + offset + searchResults.length) % searchResults.length;
                } while (!isSelectable(searchResults[next]));
                setActive(next);
            }
        }
        else {
            setSearchTerm(rl.line);
        }
    });
    const message = theme.style.message(config.message);
    if (active > 0) {
        firstRender.current = false;
    }
    let helpTip = '';
    if (status === 'pending' &&
        searchResults.length > 0 &&
        (theme.helpMode === 'always' || (theme.helpMode === 'auto' && firstRender.current))) {
        helpTip =
            searchResults.length > pageSize
                ? `\n${theme.style.help('(Use arrow keys to reveal more choices)')}`
                : theme.style.help('(Use arrow keys)');
    }
    const page = (0, core_1.usePagination)({
        items: searchResults,
        active,
        renderItem({ item, isActive }) {
            if (core_1.Separator.isSeparator(item)) {
                return ` ${item.separator}`;
            }
            const line = String(item.name || item.value);
            if (item.disabled) {
                const disabledLabel = typeof item.disabled === 'string' ? item.disabled : '(disabled)';
                return theme.style.disabled(`${line} ${disabledLabel}`);
            }
            const color = isActive ? theme.style.highlight : (x) => x;
            const cursor = isActive ? theme.icon.cursor : ` `;
            return replaceMatchedTextColor(`${cursor} ${line}`, searchTerm, color, yoctocolors_cjs_1.default.yellow);
        },
        pageSize,
        loop: false,
    });
    let error;
    if (searchError) {
        error = theme.style.error(searchError);
    }
    else if (searchResults.length === 0 && searchTerm !== '' && status === 'pending') {
        error = theme.style.error('No results found');
    }
    let searchStr;
    if (status === 'done' && selectedChoice) {
        const converter = config.answerConverter ?? defaultAnswerConverter;
        const answer = converter(selectedChoice.short ??
            selectedChoice.name ??
            String(selectedChoice.value));
        return `${prefix} ${message} ${theme.style.answer(answer)}`;
    }
    else {
        searchStr = theme.style.searchTerm(searchTerm);
    }
    const choiceDescription = selectedChoice?.description
        ? `\n${theme.style.description(selectedChoice.description)}`
        : ``;
    return [
        [prefix, message, searchStr].filter(Boolean).join(' '),
        `${config.header}${error ?? page}${config.bottom}${helpTip}${choiceDescription}`,
    ];
});
function replaceMatchedTextColor(text, searchTerm, defaultColor, matchedColor) {
    if (searchTerm.length === 0) {
        return defaultColor(text);
    }
    else {
        return text
            .split(searchTerm)
            .map((t) => defaultColor(t))
            .join(matchedColor(searchTerm));
    }
}
function defaultAnswerConverter(answer) {
    const split = answer
        .split(table_1.DEFAULT_TABLE_STYLE.vertical)
        .slice(1, -1)
        .map((t) => t.trim());
    return `${split[0]} (${split.slice(1).join(', ')}) `;
}
//# sourceMappingURL=table-search.js.map