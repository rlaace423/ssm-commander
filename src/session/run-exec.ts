import { existsSync } from 'node:fs';
import { createEcsClient } from '../aws/clients.js';
import { buildExecTarget, type ExecInput, ecsEndpoint, executeCommand } from '../aws/ecs.js';
import type { AwsContext, Sender } from '../types.js';
import { warn } from '../ui/output.js';
import { buildPluginInvocation, findPluginPath, getPluginVersion, type PluginInvocation, runPlugin } from './plugin.js';
import { preparePlugin } from './run-session.js';

export interface RunExecDeps {
  ecs: Sender;
  findPluginPath: () => string | null;
  getPluginVersion: (pluginPath: string) => Promise<string | null>;
  runPlugin: (pluginPath: string, invocation: PluginInvocation) => Promise<number>;
  warn: (message: string) => void;
  env: NodeJS.ProcessEnv;
}

export async function defaultRunExecDeps(ctx: AwsContext): Promise<RunExecDeps> {
  return {
    ecs: await createEcsClient(ctx),
    findPluginPath: () => findPluginPath({ env: process.env, platform: process.platform, exists: existsSync }),
    getPluginVersion,
    runPlugin: (pluginPath, invocation) => runPlugin(pluginPath, invocation),
    warn,
    env: process.env,
  };
}

export interface ExecSessionInput extends ExecInput {
  /** Runtime id of the container, from DescribeTasks; part of the plugin target. */
  runtimeId: string;
}

/**
 * ExecuteCommand → plugin, the way `aws ecs execute-command` does it: the target is
 * `ecs:<cluster>_<task>_<runtimeId>`, the endpoint is ECS's, and no TerminateSession follows.
 */
export async function runExecSession(ctx: AwsContext, input: ExecSessionInput, deps: RunExecDeps): Promise<number> {
  const { pluginPath, pluginVersion } = await preparePlugin(deps);
  const { runtimeId, ...exec } = input;
  const start = await executeCommand(deps.ecs, exec);
  const invocation = buildPluginInvocation({
    session: start.session,
    region: ctx.region,
    profile: ctx.profile,
    parameters: { Target: buildExecTarget(input.cluster, input.task, runtimeId) },
    endpoint: ecsEndpoint(ctx.region),
    pluginVersion,
    baseEnv: deps.env,
  });
  return deps.runPlugin(pluginPath, invocation);
}
