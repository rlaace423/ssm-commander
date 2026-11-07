import { resolveContext } from '../context.js';
import { CliError, describeAwsError, IAM_ACTIONS } from '../errors.js';
import { defaultRunSessionDeps, runSession } from '../session/run-session.js';
import type { AwsContext, StartSessionInput } from '../types.js';

export const SSH_DOCUMENT = 'AWS-StartSSHSession';

export interface ProxyOptions {
  profile?: string;
  region?: string;
  target?: string;
  port?: number;
}

export interface ProxyDeps {
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  runSession: (ctx: AwsContext, input: StartSessionInput) => Promise<number>;
}

export function defaultProxyDeps(): ProxyDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    runSession: (ctx, input) => runSession(ctx, input, defaultRunSessionDeps(ctx)),
  };
}

/**
 * ProxyCommand target for ssh/scp: opens an AWS-StartSSHSession whose stdin/stdout are the pipes ssh gave us.
 * Nothing may be written to stdout here; it is the SSH data channel.
 */
export async function runProxy(opts: ProxyOptions, deps: ProxyDeps = defaultProxyDeps()): Promise<number> {
  if (!opts.profile || !opts.region || !opts.target) {
    throw new CliError('proxy needs --profile, --region and --target');
  }
  const ctx = await deps.resolveContext({ profile: opts.profile, region: opts.region });
  try {
    return await deps.runSession(ctx, {
      Target: opts.target,
      DocumentName: SSH_DOCUMENT,
      Parameters: { portNumber: [String(opts.port ?? 22)] },
    });
  } catch (err) {
    throw describeAwsError(err, { profile: ctx.profile, action: IAM_ACTIONS.ssmStart });
  }
}
