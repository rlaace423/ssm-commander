import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runConnect } from './commands/connect.js';
import { type ForwardOptions, runForward, validatePort } from './commands/forward.js';
import { type ProxyOptions, runProxy } from './commands/proxy.js';
import { runScp } from './commands/scp.js';
import { runSsh, type SshOptions } from './commands/ssh.js';
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

  program
    .command('forward')
    .description('Forward a local port to a service reachable from an EC2 instance')
    .argument('[preset]', 'name of a saved preset to run')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .option('--target <target>', 'instance id or Name tag; omit to pick from a list')
    .option('--remote-host <host>', 'host to reach from the instance ("localhost" means the instance itself)')
    .option('--remote-port <port>', 'port of the service on the remote host')
    .option('--local-port <port>', 'local port to listen on')
    .option('--save <name>', 'save these settings as a preset before connecting')
    .option('--list', 'list saved presets')
    .option('--delete <name>', 'delete a saved preset')
    .option('--connectable', 'list only instances that can be connected right now')
    .action(async (preset: string | undefined, opts: ForwardOptions) => {
      lastExitCode = await runForward(preset, opts);
    });

  const portOption = (value: string): number => {
    const valid = validatePort(value);
    if (valid !== true) throw new InvalidArgumentError(valid);
    return Number(value);
  };
  const passThroughNote =
    'Options of ssm-commander must come before the target; everything else is passed through unchanged. ' +
    'Requires an SSH server and your public key on the instance.';

  const addSshOptions = (command: Command) =>
    command
      .passThroughOptions()
      .allowUnknownOption()
      .option('--profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
      .option('--region <region>', 'AWS region (defaults to the profile region, then a prompt)')
      .option('--user <user>', 'SSH user name (default: ec2-user)')
      .option('--identity <file>', 'private key file, passed to ssh/scp as -i')
      .option('--port <port>', 'SSH port on the instance (default: 22)', portOption)
      .option('--connectable', 'list only instances that can be connected right now');

  addSshOptions(
    program
      .command('ssh')
      .description(`Open ssh to an EC2 instance through Session Manager. ${passThroughNote}`)
      .argument('[args...]', 'target (instance id or Name tag) followed by ssh options and a remote command'),
  ).action(async (args: string[], opts: SshOptions) => {
    lastExitCode = await runSsh(args, opts);
  });

  addSshOptions(
    program
      .command('scp')
      .description(`Copy files to or from an EC2 instance through Session Manager. ${passThroughNote}`)
      .argument('[args...]', 'scp arguments; exactly one side is [user@]instance:path'),
  ).action(async (args: string[], opts: SshOptions) => {
    lastExitCode = await runScp(args, opts);
  });

  program
    .command('proxy', { hidden: true })
    .description('ProxyCommand helper used by the ssh and scp commands')
    .requiredOption('--profile <profile>', 'AWS profile')
    .requiredOption('--region <region>', 'AWS region')
    .requiredOption('--target <target>', 'instance id')
    .requiredOption('--port <port>', 'SSH port on the instance', portOption)
    .action(async (opts: ProxyOptions) => {
      lastExitCode = await runProxy(opts);
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
