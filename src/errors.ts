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

export const ECS_IAM_ACTIONS = {
  listClusters: 'ecs:ListClusters',
  describeClusters: 'ecs:DescribeClusters',
  listServices: 'ecs:ListServices',
  describeServices: 'ecs:DescribeServices',
  listTasks: 'ecs:ListTasks',
  describeTasks: 'ecs:DescribeTasks',
  execute: 'ecs:ExecuteCommand',
} as const;

/** A denied call; commands with a fully specified target can carry on without the listing. */
export class AccessDeniedError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'AccessDeniedError';
  }
}

function requiredActions(action: string | undefined): string {
  const family = action?.startsWith('ecs:') ? ECS_IAM_ACTIONS : IAM_ACTIONS;
  return `Required IAM actions: ${Object.values(family).join(', ')}`;
}

const REJECTED_CREDENTIALS = [
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'AuthFailure',
  'InvalidSignatureException',
];
const EXPIRED_CREDENTIALS = ['ExpiredToken', 'ExpiredTokenException'];
const ACCESS_DENIED = ['AccessDeniedException', 'UnauthorizedOperation', 'AccessDenied'];
const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'];

export interface AwsErrorContext {
  profile: string;
  /** The IAM action the call needed, for the access-denied hint. */
  action?: string;
  /** Known when the call was scoped: the messages then say where the lookup happened. */
  region?: string;
  cluster?: string;
}

/** Turns an SDK/provider error into a CliError with a one-line cause and a one-line hint. */
export function describeAwsError(err: unknown, ctx: AwsErrorContext): CliError {
  if (err instanceof CliError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    name?: string;
    code?: string;
    message?: string;
    hostname?: string;
  };
  const name = e.name ?? '';
  const code = e.code ?? '';
  const profile = `profile "${ctx.profile}"`;

  if (name === 'CredentialsProviderError') {
    // the provider's own message usually says exactly what is missing or expired; keep it as the hint
    const detail = e.message?.trim();
    return new CliError(
      `Could not load credentials for ${profile}`,
      detail || 'Check ~/.aws/credentials and ~/.aws/config',
    );
  }
  if (REJECTED_CREDENTIALS.includes(name)) return new CliError(`AWS rejected the credentials of ${profile}`);
  if (EXPIRED_CREDENTIALS.includes(name)) return new CliError(`The credentials of ${profile} have expired`);
  if (ACCESS_DENIED.includes(name)) {
    return new AccessDeniedError(
      `Profile "${ctx.profile}" is not allowed to perform ${ctx.action ?? 'this operation'}`,
      requiredActions(ctx.action),
    );
  }
  if (name === 'TargetNotConnected') {
    return new CliError(
      'The instance is not connected to Systems Manager',
      'Check that the SSM agent is running and the instance profile allows Session Manager',
    );
  }
  if (name === 'TargetNotConnectedException') {
    return new CliError(
      'The container is not reachable through ECS Exec',
      'Check that the task role allows ssmmessages:CreateControlChannel, CreateDataChannel, OpenControlChannel and OpenDataChannel, and that the ExecuteCommandAgent is running',
    );
  }
  if (name === 'InvalidParameterException' && /execute command/i.test(e.message ?? '')) {
    return new CliError(
      'ECS Exec is not enabled for this task',
      'Start the service or task with enableExecuteCommand (for a service: aws ecs update-service --enable-execute-command --force-new-deployment) and wait for the agent to come up',
    );
  }
  if (name === 'ClusterNotFoundException') {
    const what = ctx.cluster !== undefined ? `Cluster "${ctx.cluster}"` : 'The ECS cluster';
    const where = ctx.region !== undefined ? ` in ${ctx.region}` : '';
    return new CliError(`${what} was not found${where} (${profile})`);
  }
  if (NETWORK_CODES.includes(code) || name === 'TimeoutError') {
    const message = `Could not reach AWS (${NETWORK_CODES.includes(code) ? code : name})`;
    if (code !== 'ENOTFOUND') return new CliError(message);
    // A mistyped region makes an endpoint name that does not exist; it looks like a network failure otherwise.
    const regionName = ctx.region !== undefined ? ` "${ctx.region}"` : '';
    const hint = e.hostname
      ? `${e.hostname} did not resolve; check the network connection and the region name${regionName}`
      : `Check the network connection and the region name${regionName}`;
    return new CliError(message, hint);
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
