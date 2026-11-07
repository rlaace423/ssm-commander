import { describe, expect, test } from 'vitest';
import { CliError, describeAwsError, formatError, IAM_ACTIONS } from '../src/errors.js';

const named = (name: string) => Object.assign(new Error(`${name} happened`), { name });
const coded = (code: string) => Object.assign(new Error(`${code} happened`), { code });
const ctx = { profile: 'work' };

describe('describeAwsError', () => {
  test('CredentialsProviderError → could not load credentials', () => {
    const e = describeAwsError(named('CredentialsProviderError'), ctx);
    expect(e).toBeInstanceOf(CliError);
    expect(e.message).toBe('Could not load credentials for profile "work"');
    expect(e.hint).toBe('CredentialsProviderError happened');
    const silent = describeAwsError(Object.assign(new Error(''), { name: 'CredentialsProviderError' }), ctx);
    expect(silent.hint).toBe('Check ~/.aws/credentials and ~/.aws/config');
  });

  test.each(['UnrecognizedClientException', 'InvalidClientTokenId', 'AuthFailure', 'InvalidSignatureException'])(
    '%s → rejected credentials',
    (name) => {
      expect(describeAwsError(named(name), ctx).message).toBe('AWS rejected the credentials of profile "work"');
    },
  );

  test.each(['ExpiredToken', 'ExpiredTokenException'])('%s → expired credentials', (name) => {
    expect(describeAwsError(named(name), ctx).message).toBe('The credentials of profile "work" have expired');
  });

  test.each(['AccessDeniedException', 'UnauthorizedOperation', 'AccessDenied'])(
    '%s → permission with action',
    (name) => {
      const e = describeAwsError(named(name), { profile: 'work', action: IAM_ACTIONS.ssmStart });
      expect(e.message).toBe('Profile "work" is not allowed to perform ssm:StartSession');
      expect(e.hint).toBe(
        'Required IAM actions: ec2:DescribeInstances, ssm:DescribeInstanceInformation, ssm:StartSession, ssm:TerminateSession',
      );
    },
  );

  test('AccessDenied without an action says "this operation"', () => {
    expect(describeAwsError(named('AccessDenied'), ctx).message).toBe(
      'Profile "work" is not allowed to perform this operation',
    );
  });

  test('TargetNotConnected → agent hint', () => {
    const e = describeAwsError(named('TargetNotConnected'), ctx);
    expect(e.message).toBe('The instance is not connected to Systems Manager');
    expect(e.hint).toBe('Check that the SSM agent is running and the instance profile allows Session Manager');
  });

  test.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'])('network code %s', (code) => {
    expect(describeAwsError(coded(code), ctx).message).toBe(`Could not reach AWS (${code})`);
  });

  test('TimeoutError name → network', () => {
    expect(describeAwsError(named('TimeoutError'), ctx).message).toBe('Could not reach AWS (TimeoutError)');
  });

  test('unknown errors are wrapped keeping the message', () => {
    expect(describeAwsError(new Error('weird'), ctx).message).toBe('weird');
    expect(describeAwsError('plain string', ctx).message).toBe('plain string');
  });

  test('returns the same CliError instance', () => {
    const original = new CliError('mine', 'hint', 3);
    expect(describeAwsError(original, ctx)).toBe(original);
  });
});

describe('formatError', () => {
  test('prints hint on its own line and stack only when debug', () => {
    const e = new CliError('Bad thing', 'Do this instead');
    expect(formatError(e, false)).toBe('Bad thing\n  hint: Do this instead');
    expect(formatError(e, true)).toMatch(/^Bad thing\n {2}hint: Do this instead\nCliError: Bad thing\n {4}at /);
    const plain = new Error('kaboom');
    expect(formatError(plain, false)).toBe('Unexpected error: kaboom');
    expect(formatError(plain, true)).toMatch(/^Unexpected error: kaboom\nError: kaboom\n {4}at /);
    expect(formatError('just text', false)).toBe('Unexpected error: just text');
  });
});
