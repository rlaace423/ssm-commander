import { fromIni } from '@aws-sdk/credential-providers';
import { loadSharedConfigFiles } from '@smithy/core/config';
import type { AwsCredentialIdentityProvider, SharedConfigFiles } from '@smithy/types';
import { CliError } from '../errors.js';

const DEFAULT_PROFILE = 'default';
/** Config-file sections that are not profiles (kept with their prefix by the loader). */
const NON_PROFILE_PREFIXES = ['sso-session.', 'services.'];

export async function loadSharedConfig(): Promise<SharedConfigFiles> {
  return loadSharedConfigFiles({ ignoreCache: true });
}

export function listProfileNames(files: SharedConfigFiles): string[] {
  const names = new Set(
    [...Object.keys(files.credentialsFile), ...Object.keys(files.configFile)].filter(
      (name) => !NON_PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  );
  const rest = [...names].filter((name) => name !== DEFAULT_PROFILE).sort();
  return names.has(DEFAULT_PROFILE) ? [DEFAULT_PROFILE, ...rest] : rest;
}

export function profileRegion(files: SharedConfigFiles, profile: string): string | undefined {
  return files.configFile[profile]?.region ?? files.credentialsFile[profile]?.region;
}

export type ProfileDecision = { kind: 'use'; name: string } | { kind: 'prompt' };

export function resolveProfileName(input: {
  flag?: string;
  env: NodeJS.ProcessEnv;
  available: string[];
}): ProfileDecision {
  const requested = input.flag || input.env.AWS_PROFILE || undefined;
  if (requested !== undefined) {
    if (!input.available.includes(requested)) {
      throw new CliError(
        `Profile "${requested}" was not found in your AWS config files`,
        'Check ~/.aws/credentials and ~/.aws/config',
      );
    }
    return { kind: 'use', name: requested };
  }
  if (input.available.length === 1) return { kind: 'use', name: input.available[0] as string };
  return { kind: 'prompt' };
}

export function resolveRegion(input: {
  flag?: string;
  env: NodeJS.ProcessEnv;
  profileRegion?: string;
}): string | undefined {
  return input.flag || input.env.AWS_REGION || input.env.AWS_DEFAULT_REGION || input.profileRegion || undefined;
}

export function credentialsFor(
  profile: string,
  mfaCodeProvider: (serial: string) => Promise<string>,
): AwsCredentialIdentityProvider {
  return fromIni({ profile, mfaCodeProvider });
}
