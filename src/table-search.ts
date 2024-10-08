import {
  createPrompt,
  isEnterKey,
  makeTheme,
  Separator,
  type Theme,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useRef,
  useState,
} from '@inquirer/core';
import * as colors from 'yoctocolors-cjs';
import figures from '@inquirer/figures';
import type { PartialDeep } from '@inquirer/type';
import { DEFAULT_TABLE_STYLE } from './table.ts';

type SearchTheme = {
  icon: { cursor: string };
  style: {
    disabled: (text: string) => string;
    searchTerm: (text: string) => string;
    description: (text: string) => string;
  };
  helpMode: 'always' | 'never' | 'auto';
};

const searchTheme: SearchTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text: string) => colors.dim(`- ${text}`),
    searchTerm: (text: string) => colors.cyan(text),
    description: (text: string) => colors.cyan(text),
  },
  helpMode: 'auto',
};

type Choice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
  type?: never;
};

type SearchConfig<Value> = {
  message: string;
  header: string;
  bottom: string;
  source: (
    term: string | undefined,
    opt: { signal: AbortSignal },
  ) => ReadonlyArray<Choice<Value> | Separator> | Promise<ReadonlyArray<Choice<Value> | Separator>>;
  pageSize?: number;
  theme?: PartialDeep<Theme<SearchTheme>>;
  answerConverter?: (answer: string) => string;
};

type Item<Value> = Separator | Choice<Value>;

function isSelectable<Value>(item: Item<Value>): item is Choice<Value> {
  return !Separator.isSeparator(item) && !item.disabled;
}

export const prompt = createPrompt(<Value>(config: SearchConfig<Value>, done: (value: Value) => void) => {
  const { pageSize = 7 } = config;
  const theme = makeTheme<SearchTheme>(searchTheme, config.theme);
  const firstRender = useRef(true);
  const [status, setStatus] = useState<string>('searching');

  const [searchTerm, setSearchTerm] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ReadonlyArray<Item<Value>>>([]);
  const [searchError, setSearchError] = useState<string>();

  const isLoading = status === 'loading' || status === 'searching';
  const prefix = usePrefix({ isLoading, theme });

  const bounds = useMemo(() => {
    const first = searchResults.findIndex(isSelectable);
    const last = searchResults.findLastIndex(isSelectable);

    return { first, last };
  }, [searchResults]);

  const [active = bounds.first, setActive] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();

    setStatus('searching');
    setSearchError(undefined);

    const fetchResults = async () => {
      try {
        const results = await config.source(searchTerm || undefined, {
          signal: controller.signal,
        });

        if (!controller.signal.aborted) {
          // Reset the pointer
          setActive(undefined);
          setSearchError(undefined);
          setSearchResults(results);
          setStatus('pending');
        }
      } catch (error: unknown) {
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

  // Safe to assume the cursor position never points to a Separator.
  const selectedChoice = searchResults[active] as Choice<Value> | void;

  useKeypress((key, rl) => {
    if (isEnterKey(key) && selectedChoice) {
      setStatus('done');
      done(selectedChoice.value);
    } else if (status !== 'searching' && (key.name === 'up' || key.name === 'down')) {
      rl.clearLine(0);
      if ((key.name === 'up' && active !== bounds.first) || (key.name === 'down' && active !== bounds.last)) {
        const offset = key.name === 'up' ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + searchResults.length) % searchResults.length;
        } while (!isSelectable(searchResults[next]!));
        setActive(next);
      }
    } else {
      setSearchTerm(rl.line);
    }
  });

  const message = theme.style.message(config.message);

  if (active > 0) {
    firstRender.current = false;
  }

  let helpTip = '';
  if (
    status === 'pending' &&
    searchResults.length > 0 &&
    (theme.helpMode === 'always' || (theme.helpMode === 'auto' && firstRender.current))
  ) {
    helpTip =
      searchResults.length > pageSize
        ? `\n${theme.style.help('(Use arrow keys to reveal more choices)')}`
        : theme.style.help('(Use arrow keys)');
  }

  // TODO: What to do if no results are found? Should we display a message?
  const page = usePagination<Item<Value>>({
    items: searchResults,
    active,
    renderItem({ item, isActive }: { item: Item<Value>; isActive: boolean }) {
      if (Separator.isSeparator(item)) {
        return ` ${item.separator}`;
      }

      const line = String(item.name || item.value);
      if (item.disabled) {
        const disabledLabel = typeof item.disabled === 'string' ? item.disabled : '(disabled)';
        return theme.style.disabled(`${line} ${disabledLabel}`);
      }

      const color = isActive ? theme.style.highlight : (x: string) => x;
      const cursor = isActive ? theme.icon.cursor : ` `;
      return replaceMatchedTextColor(`${cursor} ${line}`, searchTerm, color, colors.yellow);
    },
    pageSize,
    loop: false,
  });

  let error;
  if (searchError) {
    error = theme.style.error(searchError);
  } else if (searchResults.length === 0 && searchTerm !== '' && status === 'pending') {
    error = theme.style.error('No results found');
  }

  let searchStr;
  if (status === 'done' && selectedChoice) {
    const converter = config.answerConverter ?? defaultAnswerConverter;
    const answer = converter(
      selectedChoice.short ??
        selectedChoice.name ??
        // TODO: Could we enforce that at the type level? Name should be defined for non-string values.
        String(selectedChoice.value),
    );

    return `${prefix} ${message} ${theme.style.answer(answer)}`;
  } else {
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

function replaceMatchedTextColor(
  text: string,
  searchTerm: string,
  defaultColor: (x: string) => string,
  matchedColor: (x: string) => string,
): string {
  if (searchTerm.length === 0) {
    return defaultColor(text);
  } else {
    return text
      .split(searchTerm)
      .map((t) => defaultColor(t))
      .join(matchedColor(searchTerm));
  }
}

function defaultAnswerConverter(answer: string): string {
  const split = answer
    .split(DEFAULT_TABLE_STYLE.vertical)
    .slice(1, -1)
    .map((t) => t.trim());
  // trailing space MATTERs, might be because of how colors.cyan work.
  return `${split[0]} (${split.slice(1).join(', ')}) `;
}
