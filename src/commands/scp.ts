import { assertOwnOptionsFirst, buildScpArgs, findScpRemoteOperand } from '../passthrough.js';
import { runExternal } from '../session/spawn-inherited.js';
import { defaultSshDeps, prepareTarget, type SshDeps, type SshOptions } from './ssh.js';

export async function runScp(args: string[], opts: SshOptions, deps: SshDeps = defaultSshDeps()): Promise<number> {
  assertOwnOptionsFirst(args);
  const remote = findScpRemoteOperand(args);
  const { row, proxyCommand } = await prepareTarget(remote.target, opts, 'Select an instance for scp', deps);
  const scpArgs = buildScpArgs({
    own: { user: opts.user, identity: opts.identity, port: opts.port },
    proxyCommand,
    args,
    remote,
    instanceId: row.instanceId,
  });
  deps.info(`Copying through ${row.name ?? row.instanceId} (${row.instanceId}) via Session Manager...`);
  return runExternal('scp', scpArgs, { spawn: deps.spawn });
}
