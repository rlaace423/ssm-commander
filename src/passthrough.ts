import { CliError } from './errors.js';

export const DEFAULT_SSH_USER = 'ec2-user';
/** ssh options that consume the next argv token as their value. */
export const SSH_VALUE_OPTIONS = new Set([
  '-B',
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
  '-P',
]);
/** scp options that consume the next argv token as their value. */
export const SCP_VALUE_OPTIONS = new Set(['-c', '-D', '-F', '-i', '-J', '-l', '-o', '-P', '-S', '-X']);

export interface OwnOptions {
  user?: string;
  identity?: string;
  port?: number;
}

/** How to re-run this very CLI from a ProxyCommand: the node binary plus the entry script. */
export function selfCommand(proc: { execPath: string; argv: string[] } = process): string[] {
  return [proc.execPath, proc.argv[1] ?? ''];
}

/** POSIX single-quoting for ssh's ProxyCommand (run through the user's shell); `%` is doubled because ssh expands %-tokens. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''").replace(/%/g, '%%')}'`;
}

export function buildProxyCommand(
  self: string[],
  target: { profile: string; region: string; instanceId: string; port: number },
): string {
  const parts = [
    ...self,
    'proxy',
    '--profile',
    target.profile,
    '--region',
    target.region,
    '--target',
    target.instanceId,
    '--port',
    String(target.port),
  ];
  return parts.map((part) => (part === 'proxy' || part.startsWith('--') ? part : shellQuote(part))).join(' ');
}

/** `user@target` → user and target; a bare target has no user. */
export function splitUserAtTarget(target: string | undefined): { user: string | null; target: string | undefined } {
  if (target === undefined) return { user: null, target: undefined };
  const match = /^([^@]+)@(.+)$/.exec(target);
  return match ? { user: match[1] as string, target: match[2] as string } : { user: null, target };
}

/** Leading option tokens (with their values) belong before the host; everything from the first non-option is the remote command. */
export function splitSshRest(rest: string[]): { options: string[]; command: string[] } {
  const options: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const token = rest[i] as string;
    if (!token.startsWith('-')) break;
    options.push(token);
    i += 1;
    if (SSH_VALUE_OPTIONS.has(token) && i < rest.length) {
      options.push(rest[i] as string);
      i += 1;
    }
  }
  return { options, command: rest.slice(i) };
}

export function buildSshArgs(input: {
  own: OwnOptions;
  instanceId: string;
  proxyCommand: string;
  rest: string[];
}): string[] {
  const { options, command } = splitSshRest(input.rest);
  return [
    '-o',
    `ProxyCommand=${input.proxyCommand}`,
    '-l',
    input.own.user ?? DEFAULT_SSH_USER,
    ...(input.own.identity ? ['-i', input.own.identity] : []),
    ...(input.own.port ? ['-p', String(input.own.port)] : []),
    ...options,
    input.instanceId,
    ...command,
  ];
}

export interface RemoteOperand {
  index: number;
  user: string | null;
  target: string;
  path: string;
}

const REMOTE_OPERAND = /^(?:([^@:]+)@)?([^:/]+):(.*)$/;

/** Finds the single `[user@]target:path` operand among scp arguments, skipping option values. */
export function findScpRemoteOperand(args: string[]): RemoteOperand {
  const found: RemoteOperand[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token.startsWith('-')) {
      if (SCP_VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    const match = REMOTE_OPERAND.exec(token);
    if (match) found.push({ index: i, user: match[1] ?? null, target: match[2] as string, path: match[3] ?? '' });
  }
  if (found.length === 0) throw new CliError('scp needs exactly one remote operand like user@instance-name:/path');
  if (found.length > 1) throw new CliError('scp between two remote instances is not supported');
  return found[0] as RemoteOperand;
}

export function buildScpArgs(input: {
  own: OwnOptions;
  proxyCommand: string;
  args: string[];
  remote: RemoteOperand;
  instanceId: string;
}): string[] {
  const rewritten = input.args.map((token, i) =>
    i === input.remote.index ? `${input.instanceId}:${input.remote.path}` : token,
  );
  return [
    '-o',
    `ProxyCommand=${input.proxyCommand}`,
    '-o',
    `User=${input.remote.user ?? input.own.user ?? DEFAULT_SSH_USER}`,
    ...(input.own.identity ? ['-i', input.own.identity] : []),
    ...(input.own.port ? ['-P', String(input.own.port)] : []),
    ...rewritten,
  ];
}

const OWN_LONG_OPTIONS = /^--(profile|region|user|identity|port|connectable)(=|$)/;

/** ssm-commander's own options are only recognised before the target; catch the common slip of placing them after it. */
export function assertOwnOptionsFirst(passthrough: string[]): void {
  for (const token of passthrough) {
    const match = OWN_LONG_OPTIONS.exec(token);
    if (match) {
      throw new CliError(
        `Option --${match[1]} must come before the target; after it, arguments are passed to ssh/scp unchanged`,
      );
    }
  }
}
