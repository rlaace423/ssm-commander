import { confirm, password, search, select } from '@inquirer/prompts';
import { CliError } from '../errors.js';
import { terminalTableWidth } from './table.js';

/** Prompts render on stderr so stdout stays clean for piping and for ssh ProxyCommand mode. */
export const promptIo = { output: process.stderr };

/** Two characters of prompt indent plus the cursor column sit in front of every table line. */
const PROMPT_OVERHEAD = 4;

/** The width a table may take inside a prompt on the current terminal; undefined when there is no terminal. */
export function promptTableWidth(): number | undefined {
  return terminalTableWidth(promptIo.output, PROMPT_OVERHEAD);
}

/** What a prompt is for, so a command run behind a pipe can say what it would have asked and how to avoid it. */
export interface TtyNeed {
  /** Subject of "... needs an interactive terminal", e.g. "Picking an instance". */
  what: string;
  /** The options or settings that make the prompt unnecessary. */
  hint?: string;
}

export function requireTty(
  need: TtyNeed = { what: 'This command' },
  proc: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process,
): void {
  if (!proc.stdin.isTTY || !proc.stdout.isTTY) {
    throw new CliError(`${need.what} needs an interactive terminal`, need.hint);
  }
}

export function promptProfile(names: string[]): Promise<string> {
  return select({ message: 'Select an AWS profile', choices: names.map((name) => ({ value: name })) }, promptIo);
}

export function promptRegion(regions: string[]): Promise<string> {
  return search(
    {
      message: 'Select an AWS region',
      source: (term) => regions.filter((region) => region.includes(term ?? '')).map((region) => ({ value: region })),
    },
    promptIo,
  );
}

export function promptMfaCode(serial: string): Promise<string> {
  return password({ message: `MFA code for ${serial}`, mask: true }, promptIo);
}

export function confirmOverwrite(name: string): Promise<boolean> {
  return confirm({ message: `Preset "${name}" already exists. Overwrite?`, default: false }, promptIo);
}
