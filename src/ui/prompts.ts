import { confirm, password, search, select } from '@inquirer/prompts';
import { CliError } from '../errors.js';

/** Prompts render on stderr so stdout stays clean for piping and for ssh ProxyCommand mode. */
export const promptIo = { output: process.stderr };

export function requireTty(proc: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process): void {
  if (!proc.stdin.isTTY || !proc.stdout.isTTY) {
    throw new CliError('This command needs an interactive terminal; pass --profile/--region/target explicitly');
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
