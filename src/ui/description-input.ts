import {
  createPrompt,
  isBackspaceKey,
  isEnterKey,
  isTabKey,
  makeTheme,
  type Status,
  type Theme,
  useKeypress,
  usePrefix,
  useState,
} from '@inquirer/core';
import type { PartialDeep } from '@inquirer/type';

export type DescriptionInputConfig = {
  message: string;
  /** Shown under the input while there is no validation error. */
  description: string;
  default?: string;
  required?: boolean;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
  theme?: PartialDeep<Theme>;
};

/** A text input with a help line underneath; Tab copies the default into the input for editing. */
export const descriptionInput = createPrompt<string, DescriptionInputConfig>((config, done) => {
  const { required = false, validate = () => true } = config;
  const theme = makeTheme(config.theme);
  const [status, setStatus] = useState<Status>('idle');
  const [defaultValue = '', setDefaultValue] = useState<string>(config.default);
  const [errorMsg, setError] = useState<string>();
  const [value, setValue] = useState<string>('');
  const prefix = usePrefix({ status, theme });

  useKeypress(async (key, rl) => {
    if (status !== 'idle') return;

    if (isEnterKey(key)) {
      const answer = value || defaultValue;
      setStatus('loading');
      const isValid = required && !answer ? 'You must provide a value' : await validate(answer);
      if (isValid === true) {
        setValue(answer);
        setStatus('done');
        done(answer);
      } else {
        // The line event cleared the input; restore it so the user can fix the value instead of retyping it.
        rl.write(value);
        setError(isValid || 'You must provide a valid value');
        setStatus('idle');
      }
    } else if (isBackspaceKey(key) && !value) {
      setDefaultValue(undefined);
    } else if (isTabKey(key) && !value) {
      setDefaultValue(undefined);
      rl.clearLine(0); // remove the tab character
      rl.write(defaultValue);
      setValue(defaultValue);
    } else {
      setValue(rl.line);
      setError(undefined);
    }
  });

  const message = theme.style.message(config.message, status);
  const formattedValue = status === 'done' ? theme.style.answer(value) : value;
  const defaultStr = defaultValue && status !== 'done' && !value ? theme.style.defaultAnswer(defaultValue) : undefined;
  const secondLine = errorMsg ? theme.style.error(errorMsg) : theme.style.help(config.description);

  return [[prefix, message, defaultStr, formattedValue].filter((part) => part !== undefined).join(' '), secondLine];
});
