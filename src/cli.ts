import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

export function createProgram(): Command {
  return new Command()
    .name('ssm-commander')
    .description(pkg.description)
    .version(pkg.version)
    .enablePositionalOptions();
}

export async function main(argv: string[]): Promise<number> {
  await createProgram().parseAsync(argv);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv);
}
