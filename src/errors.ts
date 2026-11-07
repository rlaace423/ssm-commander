export class CliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const PLUGIN_INSTALL_URL =
  'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

export class PluginNotFoundError extends CliError {
  constructor() {
    super('session-manager-plugin was not found on PATH', `Install it from ${PLUGIN_INSTALL_URL}`);
    this.name = 'PluginNotFoundError';
  }
}

export const IAM_ACTIONS = {
  ec2Describe: 'ec2:DescribeInstances',
  ssmDescribe: 'ssm:DescribeInstanceInformation',
  ssmStart: 'ssm:StartSession',
  ssmTerminate: 'ssm:TerminateSession',
} as const;

const REJECTED_CREDENTIALS = [
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'AuthFailure',
  'InvalidSignatureException',
];
const EXPIRED_CREDENTIALS = ['ExpiredToken', 'ExpiredTokenException'];
const ACCESS_DENIED = ['AccessDeniedException', 'UnauthorizedOperation', 'AccessDenied'];
const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'];

/** Turns an SDK/provider error into a CliError with a one-line cause and a one-line hint. */
export function describeAwsError(err: unknown, ctx: { profile: string; action?: string }): CliError {
  if (err instanceof CliError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: string; code?: string; message?: string };
  const name = e.name ?? '';
  const code = e.code ?? '';
  const profile = `profile "${ctx.profile}"`;

  if (name === 'CredentialsProviderError') {
    return new CliError(`Could not load credentials for ${profile}`, 'Check ~/.aws/credentials and ~/.aws/config');
  }
  if (REJECTED_CREDENTIALS.includes(name)) return new CliError(`AWS rejected the credentials of ${profile}`);
  if (EXPIRED_CREDENTIALS.includes(name)) return new CliError(`The credentials of ${profile} have expired`);
  if (ACCESS_DENIED.includes(name)) {
    return new CliError(
      `Profile "${ctx.profile}" is not allowed to perform ${ctx.action ?? 'this operation'}`,
      `Required IAM actions: ${Object.values(IAM_ACTIONS).join(', ')}`,
    );
  }
  if (name === 'TargetNotConnected') {
    return new CliError(
      'The instance is not connected to Systems Manager',
      'Check that the SSM agent is running and the instance profile allows Session Manager',
    );
  }
  if (NETWORK_CODES.includes(code) || name === 'TimeoutError') {
    return new CliError(`Could not reach AWS (${NETWORK_CODES.includes(code) ? code : name})`);
  }
  return new CliError(String(e.message ?? err));
}

export function formatError(err: unknown, debug: boolean): string {
  const lines: string[] = [];
  if (err instanceof CliError) {
    lines.push(err.message);
    if (err.hint) lines.push(`  hint: ${err.hint}`);
  } else {
    lines.push(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (debug && err instanceof Error && err.stack) lines.push(err.stack);
  return lines.join('\n');
}
