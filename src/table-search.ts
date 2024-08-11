import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useRef,
  useEffect,
  useMemo,
  isEnterKey,
  Separator,
  makeTheme,
  type Theme,
} from '@inquirer/core';
import colors from 'yoctocolors-cjs';
import figures from '@inquirer/figures';
import type { PartialDeep } from '@inquirer/type';
import type { Instance } from './interface.ts';

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
      return color(`${cursor} ${line}`);
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
    const answer =
      selectedChoice.short ??
      selectedChoice.name ??
      // TODO: Could we enforce that at the type level? Name should be defined for non-string values.
      String(selectedChoice.value);
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

const TABLE_STYLE = {
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

const HEADER_TITLE = {
  Name: 'Tag:Name',
  InstanceId: 'Instance Id',
  State: 'State',
  InstanceType: 'Type',
  PublicIpAddress: 'Public IP',
  PrivateIpAddress: 'Private IP',
};

const CELL_PADDING = 1;
const MARGIN_LEFT = '  ';

function calculateMaxLength(instances: Instance[]) {
  const maxLength = {
    Name: 0,
    InstanceId: 0,
    State: 0,
    InstanceType: 0,
    PublicIpAddress: 0,
    PrivateIpAddress: 0,
  };

  for (const instance of instances) {
    if ((instance.Name ?? '').length > maxLength.Name) {
      maxLength.Name = (instance.Name ?? '').length;
    }
    if (instance.InstanceId.length > maxLength.InstanceId) {
      maxLength.InstanceId = instance.InstanceId.length;
    }
    if (instance.State.length > maxLength.State) {
      maxLength.State = instance.State.length;
    }
    if (instance.InstanceType.length > maxLength.InstanceType) {
      maxLength.InstanceType = instance.InstanceType.length;
    }
    if ((instance.PublicIpAddress ?? '').length > maxLength.PublicIpAddress) {
      maxLength.PublicIpAddress = (instance.PublicIpAddress ?? '').length;
    }
    if (instance.PrivateIpAddress.length > maxLength.PrivateIpAddress) {
      maxLength.PrivateIpAddress = instance.PrivateIpAddress.length;
    }
  }

  maxLength.Name = HEADER_TITLE.Name.length > maxLength.Name ? HEADER_TITLE.Name.length : maxLength.Name;
  maxLength.InstanceId =
    HEADER_TITLE.InstanceId.length > maxLength.InstanceId ? HEADER_TITLE.InstanceId.length : maxLength.InstanceId;
  maxLength.State = HEADER_TITLE.State.length > maxLength.State ? HEADER_TITLE.State.length : maxLength.State;
  maxLength.InstanceType =
    HEADER_TITLE.InstanceType.length > maxLength.InstanceType
      ? HEADER_TITLE.InstanceType.length
      : maxLength.InstanceType;
  maxLength.PublicIpAddress =
    HEADER_TITLE.PublicIpAddress.length > maxLength.PublicIpAddress
      ? HEADER_TITLE.PublicIpAddress.length
      : maxLength.PublicIpAddress;
  maxLength.PrivateIpAddress =
    HEADER_TITLE.PrivateIpAddress.length > maxLength.PrivateIpAddress
      ? HEADER_TITLE.PrivateIpAddress.length
      : maxLength.PrivateIpAddress;

  return maxLength;
}

function drawTableLine(chars, maxLength): string {
  let result = chars.left;
  result += [
    chars.default.repeat(maxLength.Name + CELL_PADDING * 2),
    chars.default.repeat(maxLength.InstanceId + CELL_PADDING * 2),
    chars.default.repeat(maxLength.State + CELL_PADDING * 2),
    chars.default.repeat(maxLength.InstanceType + CELL_PADDING * 2),
    chars.default.repeat(maxLength.PublicIpAddress + CELL_PADDING * 2),
    chars.default.repeat(maxLength.PrivateIpAddress + CELL_PADDING * 2),
  ].join(chars.mid);
  result += chars.right + '\n';
  return result;
}

// text.length must be less than or equal to size
function drawCell(text: string, size: number) {
  return (
    ' '.repeat(CELL_PADDING) + text + ' '.repeat(size - text.length) + ' '.repeat(CELL_PADDING) + TABLE_STYLE.vertical
  );
}

export function createTable(instances: Instance[]) {
  const maxLength = calculateMaxLength(instances);

  // ┌─────┬─────┬─────┬─────┐
  let header = MARGIN_LEFT + drawTableLine(TABLE_STYLE.headerTop, maxLength);

  // │ Tag:Name │ Instance Id │ State │ Type │ Public IP │ Private IP │
  header += MARGIN_LEFT + TABLE_STYLE.vertical;
  header += [
    drawCell(HEADER_TITLE.Name, maxLength.Name),
    drawCell(HEADER_TITLE.InstanceId, maxLength.InstanceId),
    drawCell(HEADER_TITLE.State, maxLength.State),
    drawCell(HEADER_TITLE.InstanceType, maxLength.InstanceType),
    drawCell(HEADER_TITLE.PublicIpAddress, maxLength.PublicIpAddress),
    drawCell(HEADER_TITLE.PrivateIpAddress, maxLength.PrivateIpAddress),
    '\n',
  ].join('');

  // ├─────┼─────┼─────┼─────┤
  header += MARGIN_LEFT + drawTableLine(TABLE_STYLE.headerBottom, maxLength);

  const choices: {name: string, value: any }[] = [];
  for (const instance of instances) {
    const name = [
      TABLE_STYLE.vertical,
      drawCell(instance.Name ?? '', maxLength.Name),
      drawCell(instance.InstanceId, maxLength.InstanceId),
      drawCell(instance.State, maxLength.State),
      drawCell(instance.InstanceType, maxLength.InstanceType),
      drawCell(instance.PublicIpAddress ?? '', maxLength.PublicIpAddress),
      drawCell(instance.PrivateIpAddress, maxLength.PrivateIpAddress),
    ].join('');
    const value = instance;
    choices.push({ name, value });
  }

  const bottom = '\n' + MARGIN_LEFT + drawTableLine(TABLE_STYLE.tableBottom, maxLength);
  return { header, bottom, choices };
}
