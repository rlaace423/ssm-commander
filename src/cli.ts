import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { type ConnectDeps, type ConnectOptions, runConnect } from './commands/connect.js';
import { type DoctorDeps, runDoctor } from './commands/doctor.js';
import { type ExecDeps, type ExecOptions, runExec } from './commands/exec.js';
import { type ForwardDeps, type ForwardOptions, runForward, shellWord, validatePort } from './commands/forward.js';
import { type ProxyOptions, runProxy } from './commands/proxy.js';
import { runScp } from './commands/scp.js';
import { runSsh, type SshDeps, type SshOptions } from './commands/ssh.js';
import { CliError, formatError } from './errors.js';
import { COMMAND_NAMES, suggestCommand } from './suggest.js';
import { isInstanceId } from './target.js';

let lastExitCode = 0;

/** A word where a command belongs: a mistyped command, or a target written without the command it goes with. */
function unknownCommand(word: string): CliError {
  const connect = `"ssm-commander connect ${word}"`;
  const exec = `"ssm-commander exec ${word}"`;
  const suggestion = suggestCommand(word);
  if (suggestion !== null) {
    return new CliError(
      `Unknown command "${word}"`,
      `Did you mean "ssm-commander ${suggestion}"? If "${word}" is a target, write its command first, as in ${connect}`,
    );
  }
  // The shape of the word says which command it goes with: only instances have ids, only ECS targets have a slash.
  const forms = isInstanceId(word)
    ? connect
    : word.includes('/')
      ? exec
      : `${connect} for an EC2 instance, ${exec} for an ECS service`;
  return new CliError(`Unknown command "${word}"`, `A target goes after its command: ${forms}`);
}

/** `ssm-commander --connectable exec prod/api`: a command written after an option that only commands take. */
function commandAfterOption(command: string, option: string, line: readonly string[]): CliError {
  return new CliError(
    `"${command}" must come before "${option}"`,
    `Only -p, -r and --debug go before the command: "ssm-commander ${line.map(shellWord).join(' ')}"`,
  );
}

/**
 * The first word of a line on which connect is implied, or null when the line holds options only. The values of
 * connect's options are skipped. After an option connect does not have, a word may be that option's value, so only a
 * command name is taken for a word from there on; commander reports the option itself.
 */
function strayWord(tokens: readonly string[], connect: Command): { word: string; index: number } | null {
  const withValue = connect.options.filter((option) => option.required || option.optional);
  const takesValue = (token: string) => withValue.some((option) => option.short === token || option.long === token);
  const known = (token: string) =>
    connect.options.some((option) => option.long === token || token.startsWith(`${option.long}=`)) ||
    withValue.some((option) => option.short !== undefined && token.startsWith(option.short));
  let afterUnknownOption = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token === '--') {
      const word = tokens[index + 1];
      return word === undefined ? null : { word, index: index + 1 };
    }
    if (token.startsWith('-') && token.length > 1) {
      if (takesValue(token)) index++;
      else if (!known(token)) afterUnknownOption = true;
      continue;
    }
    if (COMMAND_NAMES.includes(token) || !afterUnknownOption) return { word: token, index };
  }
  return null;
}

/** Per-command dependency overrides (tests, the README demo); anything omitted uses the real AWS, prompt and plugin wiring. */
export interface ProgramDeps {
  connect?: ConnectDeps;
  forward?: ForwardDeps;
  ssh?: SshDeps;
  scp?: SshDeps;
  exec?: ExecDeps;
  doctor?: DoctorDeps;
}

export function createProgram(deps: ProgramDeps = {}): Command {
  const program = new Command()
    .name('ssm-commander')
    .description(pkg.description)
    .version(pkg.version)
    .enablePositionalOptions()
    .option('--debug', 'print stack traces for unexpected errors')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .exitOverride();

  /** `--debug` is read from argv by main(); each command accepts it too so it may follow the command name. */
  const command = (name: string, opts?: { isDefault?: boolean; hidden?: boolean }) =>
    program.command(name, opts).addOption(new Option('--debug').hideHelp());

  /**
   * -p and -r may be written before the command, where the program takes them (as it takes --debug), or after it,
   * where the command does; the command's own value wins. After ssh and scp only the long forms are theirs.
   */
  const withGlobals = <T extends { profile?: string; region?: string }>(opts: T): T => {
    const { profile, region } = program.opts<{ profile?: string; region?: string }>();
    return { ...opts, profile: opts.profile ?? profile, region: opts.region ?? region };
  };

  // The first word is always a command. Without one connect runs and takes options only, but commander would hand
  // it the rest of the line: a word that is no command as its target, and so too a command written after an option
  // that only commands take. Both are refused here, before the line is read as connect's arguments and before
  // anything is checked, asked or fetched.
  program.hook('preSubcommand', (root, subcommand) => {
    if (subcommand.name() !== 'connect' || root.args[0] === 'connect') return;
    const stray = strayWord(root.args, subcommand);
    if (stray === null) return;
    if (!COMMAND_NAMES.includes(stray.word)) throw unknownCommand(stray.word);
    // root.args is the end of the line, from the first thing the program did not take itself: an option, since a
    // command there would have been run. What the program did take stays in front of the command, where -p and -r
    // mean the same for every command.
    const { profile, region, debug } = program.opts<{ profile?: string; region?: string; debug?: boolean }>();
    throw commandAfterOption(stray.word, root.args[0] as string, [
      ...(profile === undefined ? [] : ['-p', profile]),
      ...(region === undefined ? [] : ['-r', region]),
      ...(debug ? ['--debug'] : []),
      stray.word,
      ...root.args.filter((_, index) => index !== stray.index),
    ]);
  });

  command('connect', { isDefault: true })
    .description('Open an interactive shell on an EC2 instance through Session Manager')
    .argument('[target]', 'instance id or Name tag; omit to pick from a list')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .option('--connectable', 'list only instances that can be connected right now')
    .action(async (target: string | undefined, opts: ConnectOptions) => {
      lastExitCode = await runConnect(target, withGlobals(opts), deps.connect);
    });

  command('exec')
    .description('Open an interactive shell in an ECS container through ECS Exec')
    .argument('[target]', 'service, cluster/service or cluster/service/task-id; omit to pick from lists')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .option('--cluster <name>', 'ECS cluster')
    .option('--service <name>', 'ECS service')
    .option('--task <id>', 'task id; with --cluster no listing is needed')
    .option('--container <name>', 'container name (asked when the task has several)')
    .option('--command <command>', 'command to run in the container (default: /bin/sh)')
    .option('--connectable', 'list only clusters, services and tasks that can be reached right now')
    .action(async (target: string | undefined, opts: ExecOptions) => {
      lastExitCode = await runExec(target, withGlobals(opts), deps.exec);
    });

  command('forward')
    .description('Forward a local port to a service reachable from an EC2 instance or an ECS task')
    .argument('[preset]', 'name of a saved preset to run')
    .option('-p, --profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
    .option('-r, --region <region>', 'AWS region (defaults to the profile region, then a prompt)')
    .option('--target <target>', 'instance id or Name tag, or ecs:cluster/service[/task-id]; omit to pick from a list')
    .option('--ecs', 'go through an ECS task instead of an instance (pick cluster, service and task from lists)')
    .option('--container <name>', 'container of the ECS task to go through (asked when there are several)')
    .option(
      '--remote-host <host>',
      'host to reach from the instance or task ("localhost" means the instance or task itself)',
    )
    .option('--remote-port <port>', 'port of the service on the remote host')
    .option('--local-port <port>', 'local port to listen on')
    .option('--save <name>', 'save these settings as a preset before connecting')
    .option('--list', 'list saved presets')
    .option('--delete <name>', 'delete a saved preset')
    .option('--connectable', 'list only instances that can be connected right now')
    .action(async (preset: string | undefined, opts: ForwardOptions) => {
      lastExitCode = await runForward(preset, withGlobals(opts), deps.forward);
    });

  const portOption = (value: string): number => {
    const valid = validatePort(value);
    if (valid !== true) throw new InvalidArgumentError(valid);
    return Number(value);
  };
  const sshNote =
    'Options of ssm-commander come before the target; everything after the target is passed to ssh unchanged. ' +
    'Requires an SSH server and your public key on the instance.';
  const scpNote =
    "Options of ssm-commander come first, then scp's own flags, then the two paths (scp reads flags after the " +
    'paths as file names). Requires an SSH server and your public key on the instance.';

  const addSshOptions = (command: Command) =>
    command
      .passThroughOptions()
      .allowUnknownOption()
      .option('--profile <profile>', 'AWS profile (defaults to AWS_PROFILE, then a prompt)')
      .option('--region <region>', 'AWS region (defaults to the profile region, then a prompt)')
      .option('--user <user>', 'SSH login name (default: ubuntu on Ubuntu, admin on Debian, ec2-user otherwise)')
      .option('--identity <file>', 'private key file, passed to ssh/scp as -i')
      .option('--port <port>', 'SSH port on the instance (default: 22)', portOption)
      .option('--connectable', 'list only instances that can be connected right now');

  addSshOptions(
    command('ssh')
      .description(`Open ssh to an EC2 instance through Session Manager. ${sshNote}`)
      .argument('[args...]', 'target (instance id or Name tag) followed by ssh options and a remote command'),
  ).action(async (args: string[], opts: SshOptions) => {
    lastExitCode = await runSsh(args, withGlobals(opts), deps.ssh);
  });

  addSshOptions(
    command('scp')
      .description(`Copy files to or from an EC2 instance through Session Manager. ${scpNote}`)
      .argument('[args...]', 'scp arguments; exactly one side is [user@]instance:path'),
  ).action(async (args: string[], opts: SshOptions) => {
    lastExitCode = await runScp(args, withGlobals(opts), deps.scp);
  });

  command('doctor')
    .description(
      'Check Node.js, session-manager-plugin, AWS config files, (with --profile) the credentials and (with --ecs) ECS Exec',
    )
    .option('-p, --profile <profile>', 'profile whose credentials to verify with STS GetCallerIdentity')
    .option('-r, --region <region>', 'region for the ECS checks (defaults to the profile region)')
    .option('--ecs <target>', 'also check the ECS Exec prerequisites of cluster/service[/task-id]')
    .action(async (opts: { profile?: string; region?: string; ecs?: string }) => {
      lastExitCode = await runDoctor(withGlobals(opts), deps.doctor);
    });

  command('proxy', { hidden: true })
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

export async function main(argv: string[], deps: ProgramDeps = {}): Promise<number> {
  lastExitCode = 0;
  const debug = argv.includes('--debug') || process.env.SSM_COMMANDER_DEBUG === '1';
  try {
    await createProgram(deps).parseAsync(argv);
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
