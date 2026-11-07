import type { AwsCredentialIdentityProvider, SharedConfigFiles } from '@smithy/types';
import {
  credentialsFor,
  listProfileNames,
  loadSharedConfig,
  profileRegion,
  resolveProfileName,
  resolveRegion,
} from './aws/profiles.js';
import { listRegions } from './aws/regions.js';
import { CliError } from './errors.js';
import type { AwsContext } from './types.js';
import { promptMfaCode, promptProfile, promptRegion, requireTty } from './ui/prompts.js';

export interface ContextDeps {
  loadSharedConfig: () => Promise<SharedConfigFiles>;
  promptProfile: (names: string[]) => Promise<string>;
  promptRegion: (regions: string[]) => Promise<string>;
  listRegions: (credentials: AwsCredentialIdentityProvider) => Promise<string[]>;
  requireTty: () => void;
  env: NodeJS.ProcessEnv;
  credentialsFor: (
    profile: string,
    mfaCodeProvider: (serial: string) => Promise<string>,
  ) => AwsCredentialIdentityProvider;
  promptMfaCode: (serial: string) => Promise<string>;
}

export function defaultContextDeps(): ContextDeps {
  return {
    loadSharedConfig,
    promptProfile,
    promptRegion,
    listRegions: (credentials) => listRegions(credentials),
    requireTty: () => requireTty(),
    env: process.env,
    credentialsFor,
    promptMfaCode,
  };
}

/** Profile, region and credentials: flags, then environment, then shared config, then prompts (TTY required). */
export async function resolveContext(
  opts: { profile?: string; region?: string },
  deps: ContextDeps = defaultContextDeps(),
): Promise<AwsContext> {
  const files = await deps.loadSharedConfig();
  const available = listProfileNames(files);
  if (available.length === 0) {
    throw new CliError('No AWS profiles found', 'Run "aws configure" or create ~/.aws/credentials');
  }

  const decision = resolveProfileName({ flag: opts.profile, env: deps.env, available });
  let profile: string;
  if (decision.kind === 'use') {
    profile = decision.name;
  } else {
    deps.requireTty();
    profile = await deps.promptProfile(available);
  }

  const credentials = deps.credentialsFor(profile, async (serial) => {
    deps.requireTty(); // an MFA prompt cannot be answered in proxy mode or behind a pipe
    return deps.promptMfaCode(serial);
  });
  let region = resolveRegion({ flag: opts.region, env: deps.env, profileRegion: profileRegion(files, profile) });
  if (region === undefined) {
    deps.requireTty();
    region = await deps.promptRegion(await deps.listRegions(credentials));
  }
  return { profile, region, credentials };
}
