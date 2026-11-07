import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runConnect } from './commands/connect.js';
import { CliError, formatError } from './errors.js';

let lastExitCode = 0;

export function createProgram(): Command {
  const program = new Command()
    .name('ssm-commander')
    .description(pkg.description)
    .version(pkg.version)
    .enablePositionalOptions()
    .option('--debug', 'print stack traces for unexpected errors')
    .exitOverride();

  program
    .command('connect', { isDefault: true })
    .description('Open an interactive shell on an EC2 instance through Session Manager')
    .argument('[target]', 'instance id or Name tag; omit to pick from a list')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .option('--connectable', 'list only instances that can be connected right now')
    .action(async (target: string | undefined, opts: { profile?: string; region?: string; connectable?: boolean }) => {
      lastExitCode = await runConnect(target, opts);
    });

  return program;
}

export async function main(argv: string[]): Promise<number> {
  lastExitCode = 0;
  const debug = argv.includes('--debug') || process.env.SSM_COMMANDER_DEBUG === '1';
  try {
    await createProgram().parseAsync(argv);
    return lastExitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode; // help, version and usage errors are already printed
    if (err instanceof Error && err.name === 'ExitPromptError') return 130; // Ctrl+C inside a prompt
    process.stderr.write(`${formatError(err, debug)}\n`);
    return err instanceof CliError ? err.exitCode : 1;
  }
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
