import { styleText } from 'node:util';
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  type Status,
  type Theme,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useRef,
  useState,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import type { PartialDeep } from '@inquirer/type';
import { firstCell } from './table.js';

type SearchTheme = {
  icon: { cursor: string };
  style: {
    disabled: (text: string) => string;
    searchTerm: (text: string) => string;
    description: (text: string) => string;
    match: (text: string) => string;
  };
  helpMode: 'always' | 'never' | 'auto';
};

const searchTheme: SearchTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text) => styleText('dim', `- ${text}`),
    searchTerm: (text) => styleText('cyan', text),
    description: (text) => styleText('cyan', text),
    match: (text) => styleText('yellow', text),
  },
  helpMode: 'auto',
};

export type TableChoice<Value> = {
  name: string;
  value: Value;
  disabled?: boolean | string;
  description?: string;
};

export type TableSearchConfig<Value> = {
  message: string;
  header: string;
  footer: string;
  source: (term: string | undefined) => ReadonlyArray<TableChoice<Value>> | Promise<ReadonlyArray<TableChoice<Value>>>;
  pageSize?: number;
  theme?: PartialDeep<Theme<SearchTheme>>;
};

function isSelectable<Value>(item: TableChoice<Value>): boolean {
  return !item.disabled;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Paints the parts of `text` that match `term` (case-insensitively) with `match`, the rest with `base`. */
export function highlightMatches(
  text: string,
  term: string,
  base: (t: string) => string,
  match: (t: string) => string,
): string {
  if (term.length === 0) return base(text);
  const pattern = new RegExp(escapeRegExp(term), 'gi');
  let out = '';
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (start > last) out += base(text.slice(last, start));
    out += match(found[0]);
    last = start + found[0].length;
  }
  if (last < text.length) out += base(text.slice(last));
  return out;
}

/** Lines of the table header/footer are indented to line up with the cursor column of the list. */
function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** A searchable list whose rows are pre-rendered table lines; disabled rows are shown dimmed and skipped by the cursor. */
export const tableSearch = createPrompt(
  <Value>(config: TableSearchConfig<Value>, done: (value: Value) => void): string | [string, string | undefined] => {
    const { pageSize = 7 } = config;
    const theme = makeTheme<SearchTheme>(searchTheme, config.theme);
    const firstRender = useRef(true);
    const [status, setStatus] = useState<Status>('loading');
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [results, setResults] = useState<ReadonlyArray<TableChoice<Value>>>([]);
    const [searchError, setSearchError] = useState<string>();
    const prefix = usePrefix({ status, theme });

    const bounds = useMemo(
      () => ({ first: results.findIndex(isSelectable), last: results.findLastIndex(isSelectable) }),
      [results],
    );
    const [active = bounds.first, setActive] = useState<number>();

    useEffect(() => {
      const controller = new AbortController();
      setStatus('loading');
      setSearchError(undefined);
      const load = async () => {
        try {
          const next = await config.source(searchTerm || undefined);
          if (controller.signal.aborted) return;
          setActive(undefined);
          setSearchError(undefined);
          setResults(next);
          setStatus('idle');
        } catch (error) {
          if (controller.signal.aborted) return;
          setSearchError(error instanceof Error ? error.message : String(error));
          setStatus('idle');
        }
      };
      void load();
      return () => controller.abort();
    }, [searchTerm]);

    const selected = results[active] as TableChoice<Value> | undefined;

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        if (selected && isSelectable(selected)) {
          setStatus('done');
          done(selected.value);
        } else {
          // The line event cleared the input; put the search term back so the user can keep editing it.
          rl.write(searchTerm);
        }
      } else if (status !== 'loading' && (isUpKey(key, theme.keybindings) || isDownKey(key, theme.keybindings))) {
        rl.clearLine(0);
        const up = isUpKey(key, theme.keybindings);
        if ((up && active !== bounds.first) || (!up && active !== bounds.last)) {
          const offset = up ? -1 : 1;
          let next = active;
          do {
            next = (next + offset + results.length) % results.length;
          } while (!isSelectable(results[next] as TableChoice<Value>));
          setActive(next);
        }
      } else {
        setSearchTerm(rl.line);
      }
    });

    const message = theme.style.message(config.message, status);
    if (active > 0) firstRender.current = false;

    let helpTip = '';
    if (
      status === 'idle' &&
      results.length > 0 &&
      (theme.helpMode === 'always' || (theme.helpMode === 'auto' && firstRender.current))
    ) {
      helpTip =
        results.length > pageSize
          ? `\n${theme.style.help('(Use arrow keys to reveal more choices)')}`
          : `\n${theme.style.help('(Use arrow keys)')}`;
    }

    const page = usePagination<TableChoice<Value>>({
      items: results,
      active,
      renderItem({ item, isActive }) {
        if (item.disabled) {
          const label = typeof item.disabled === 'string' ? ` ${item.disabled}` : '';
          return theme.style.disabled(`${item.name}${label}`);
        }
        const paint = isActive ? theme.style.highlight : (text: string) => text;
        const cursor = isActive ? theme.icon.cursor : ' ';
        return highlightMatches(`${cursor} ${item.name}`, searchTerm, paint, theme.style.match);
      },
      pageSize,
      loop: false,
    });

    if (status === 'done' && selected) {
      return `${prefix} ${message} ${theme.style.answer(firstCell(selected.name))}`;
    }

    let error: string | undefined;
    if (searchError) {
      error = theme.style.error(searchError);
    } else if (results.length === 0 && searchTerm !== '' && status === 'idle') {
      error = theme.style.error('No results found');
    }

    const searchStr = theme.style.searchTerm(searchTerm);
    const description = selected?.description ? `\n${theme.style.description(selected.description)}` : '';
    const body = `${indent(config.header)}\n${error ?? page}\n${indent(config.footer)}${helpTip}${description}`;
    return [[prefix, message, searchStr].filter(Boolean).join(' '), body];
  },
);
