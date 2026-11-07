import type { SharedConfigFiles } from '@smithy/types';
import { describe, expect, test, vi } from 'vitest';
import {
  credentialsFor,
  listProfileNames,
  profileRegion,
  resolveProfileName,
  resolveRegion,
} from '../../src/aws/profiles.js';
import { CliError } from '../../src/errors.js';

const files: SharedConfigFiles = {
  credentialsFile: {
    default: { aws_access_key_id: 'x' },
    work: { aws_access_key_id: 'y', region: 'us-west-2' },
  },
  configFile: {
    default: { region: 'ap-northeast-2' },
    personal: { region: 'eu-west-1' },
    'sso-session.corp': { sso_start_url: 'u' },
    'services.s3': {},
  },
};
const available = ['default', 'personal', 'work'];

describe('listProfileNames', () => {
  test('unions both files, default first, excludes sso-session/services, sorts the rest', () => {
    expect(listProfileNames(files)).toEqual(['default', 'personal', 'work']);
  });

  test('omits default when neither file defines it', () => {
    expect(listProfileNames({ credentialsFile: { b: {} }, configFile: { a: {} } })).toEqual(['a', 'b']);
  });
});

describe('profileRegion', () => {
  test('prefers config file then credentials file', () => {
    expect(profileRegion(files, 'default')).toBe('ap-northeast-2');
    expect(profileRegion(files, 'work')).toBe('us-west-2');
    expect(profileRegion(files, 'nope')).toBeUndefined();
  });
});

describe('resolveProfileName', () => {
  test('flag wins and must exist', () => {
    expect(resolveProfileName({ flag: 'work', env: { AWS_PROFILE: 'personal' }, available })).toEqual({
      kind: 'use',
      name: 'work',
    });
    expect(() => resolveProfileName({ flag: 'nope', env: {}, available })).toThrow(CliError);
    expect(() => resolveProfileName({ flag: 'nope', env: {}, available })).toThrow(
      'Profile "nope" was not found in your AWS config files',
    );
  });

  test('AWS_PROFILE used when no flag', () => {
    expect(resolveProfileName({ env: { AWS_PROFILE: 'personal' }, available })).toEqual({
      kind: 'use',
      name: 'personal',
    });
    expect(() => resolveProfileName({ env: { AWS_PROFILE: 'ghost' }, available })).toThrow(CliError);
  });

  test('single available profile is used without prompt', () => {
    expect(resolveProfileName({ env: {}, available: ['default'] })).toEqual({ kind: 'use', name: 'default' });
  });

  test('multiple profiles and nothing set → prompt', () => {
    expect(resolveProfileName({ env: {}, available })).toEqual({ kind: 'prompt' });
  });
});

describe('resolveRegion', () => {
  test('precedence flag > AWS_REGION > AWS_DEFAULT_REGION > profileRegion > undefined', () => {
    const env = { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-2' };
    expect(resolveRegion({ flag: 'eu-west-1', env, profileRegion: 'ap-northeast-2' })).toBe('eu-west-1');
    expect(resolveRegion({ env, profileRegion: 'ap-northeast-2' })).toBe('us-east-1');
    expect(resolveRegion({ env: { AWS_DEFAULT_REGION: 'us-east-2' }, profileRegion: 'ap-northeast-2' })).toBe(
      'us-east-2',
    );
    expect(resolveRegion({ env: {}, profileRegion: 'ap-northeast-2' })).toBe('ap-northeast-2');
    expect(resolveRegion({ env: {} })).toBeUndefined();
  });
});

describe('credentialsFor', () => {
  const creds = (expiration?: Date) => ({
    accessKeyId: 'k',
    secretAccessKey: 's',
    ...(expiration ? { expiration } : {}),
  });

  test('resolves the profile once and shares the result across concurrent and later callers', async () => {
    const inner = vi.fn(async () => creds());
    const provider = credentialsFor('default', async () => '000000', { fromIni: () => inner });
    const [a, b] = await Promise.all([provider(), provider()]);
    const c = await provider();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  test('refreshes credentials that are about to expire and does not cache failures', async () => {
    const soon = new Date(Date.now() + 60_000);
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new Error('wrong mfa'))
      .mockResolvedValueOnce(creds(soon))
      .mockResolvedValueOnce(creds(new Date(Date.now() + 3_600_000)));
    const provider = credentialsFor('default', async () => '000000', { fromIni: () => inner });
    await expect(provider()).rejects.toThrow('wrong mfa');
    await provider(); // expiring soon → next call re-resolves
    await provider();
    await provider(); // fresh for an hour → cached
    expect(inner).toHaveBeenCalledTimes(3);
  });

  test('passes the profile and mfa provider to fromIni', () => {
    const fromIni = vi.fn(() => async () => creds());
    const mfa = async () => '1';
    credentialsFor('work', mfa, { fromIni });
    expect(fromIni).toHaveBeenCalledWith({ profile: 'work', mfaCodeProvider: mfa });
  });
});
