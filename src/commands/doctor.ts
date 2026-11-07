import { existsSync } from 'node:fs';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { SharedConfigFiles } from '@smithy/types';
import { createStsClient } from '../aws/clients.js';
import { listProfileNames, loadSharedConfig } from '../aws/profiles.js';
import { resolveContext } from '../context.js';
import { describeAwsError, PLUGIN_INSTALL_URL } from '../errors.js';
import { compareVersions, findPluginPath, getPluginVersion, RECOMMENDED_MIN_VERSION } from '../session/plugin.js';
import type { AwsContext } from '../types.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  nodeVersion: string;
  findPluginPath: () => string | null;
  getPluginVersion: (pluginPath: string) => Promise<string | null>;
  loadSharedConfig: () => Promise<SharedConfigFiles>;
  resolveContext: (opts: { profile?: string }) => Promise<AwsContext>;
  getCallerIdentity: (ctx: AwsContext) => Promise<{ Account?: string; Arn?: string }>;
  writeStdout: (text: string) => void;
}

const MIN_NODE_MAJOR = 22;

export function defaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    findPluginPath: () => findPluginPath({ env: process.env, platform: process.platform, exists: existsSync }),
    getPluginVersion,
    loadSharedConfig,
    resolveContext: (opts) => resolveContext(opts),
    getCallerIdentity: (ctx) => createStsClient(ctx).send(new GetCallerIdentityCommand({})),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
  };
}

function checkNode(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: 'Node.js', ok: true, detail: `v${version}` }
    : { name: 'Node.js', ok: false, detail: `v${version} (${MIN_NODE_MAJOR} or newer is required)` };
}

async function checkPlugin(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'session-manager-plugin';
  const pluginPath = deps.findPluginPath();
  if (pluginPath === null) return { name, ok: false, detail: `not found on PATH (install: ${PLUGIN_INSTALL_URL})` };
  const version = await deps.getPluginVersion(pluginPath);
  if (version === null) return { name, ok: true, detail: `${pluginPath} (version unknown)` };
  const outdated = compareVersions(version, RECOMMENDED_MIN_VERSION) < 0;
  return {
    name,
    ok: true,
    detail: `${version} at ${pluginPath}${outdated ? ` (older than recommended ${RECOMMENDED_MIN_VERSION})` : ''}`,
  };
}

async function checkConfigFiles(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'AWS config files';
  const profiles = listProfileNames(await deps.loadSharedConfig());
  if (profiles.length === 0) {
    return { name, ok: false, detail: 'no profiles found in ~/.aws/config or ~/.aws/credentials' };
  }
  return {
    name,
    ok: true,
    detail: `${profiles.length} profile${profiles.length === 1 ? '' : 's'}: ${profiles.join(', ')}`,
  };
}

async function checkCredentials(profile: string, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = `Credentials for "${profile}"`;
  try {
    const ctx = await deps.resolveContext({ profile });
    const identity = await deps.getCallerIdentity(ctx);
    return { name, ok: true, detail: `account ${identity.Account ?? '?'}, ${identity.Arn ?? 'unknown identity'}` };
  } catch (err) {
    return { name, ok: false, detail: describeAwsError(err, { profile }).message };
  }
}

export async function runDoctorChecks(opts: { profile?: string }, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks = [checkNode(deps.nodeVersion), await checkPlugin(deps), await checkConfigFiles(deps)];
  if (opts.profile) checks.push(await checkCredentials(opts.profile, deps));
  return checks;
}

export function renderDoctorReport(checks: DoctorCheck[]): string {
  return `${checks.map((check) => `${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}`).join('\n')}\n`;
}

/** Prints the environment report to stdout; exit code 1 if any check failed. */
export async function runDoctor(opts: { profile?: string }, deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  const checks = await runDoctorChecks(opts, deps);
  deps.writeStdout(renderDoctorReport(checks));
  return checks.every((check) => check.ok) ? 0 : 1;
}
