import { describe, expect, test } from 'vitest';
import {
  AccessDeniedError,
  CliError,
  describeAwsError,
  ECS_IAM_ACTIONS,
  formatError,
  IAM_ACTIONS,
} from '../src/errors.js';

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

  test('ENOTFOUND names the host that did not resolve and points at the region name', () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND ec2.nowhere-1.amazonaws.com'), {
      code: 'ENOTFOUND',
      hostname: 'ec2.nowhere-1.amazonaws.com',
    });
    const e = describeAwsError(dns, { profile: 'work', region: 'nowhere-1' });
    expect(e.message).toBe('Could not reach AWS (ENOTFOUND)');
    expect(e.hint).toBe(
      'ec2.nowhere-1.amazonaws.com did not resolve; check the network connection and the region name "nowhere-1"',
    );
    expect(describeAwsError(coded('ENOTFOUND'), ctx).hint).toBe('Check the network connection and the region name');
    expect(describeAwsError(coded('ECONNREFUSED'), ctx).hint).toBeUndefined();
  });

  test('ClusterNotFoundException names the cluster, the region and the profile when they are known', () => {
    const scoped = describeAwsError(named('ClusterNotFoundException'), {
      profile: 'work',
      region: 'ap-northeast-2',
      cluster: 'nothing',
    });
    expect(scoped.message).toBe('Cluster "nothing" was not found in ap-northeast-2 (profile "work")');
    expect(describeAwsError(named('ClusterNotFoundException'), ctx).message).toBe(
      'The ECS cluster was not found (profile "work")',
    );
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

describe('describeAwsError for ECS', () => {
  test('access denied is an AccessDeniedError whose hint lists only the ECS actions for an ECS action', () => {
    const e = describeAwsError(named('AccessDeniedException'), {
      profile: 'work',
      action: ECS_IAM_ACTIONS.listClusters,
    });
    expect(e).toBeInstanceOf(AccessDeniedError);
    expect(e.message).toContain('ecs:ListClusters');
    expect(e.hint).toContain('ecs:ExecuteCommand');
    expect(e.hint).not.toContain('ec2:DescribeInstances');
  });

  test('access denied for an EC2 action keeps the EC2/SSM action list', () => {
    const e = describeAwsError(named('UnauthorizedOperation'), { profile: 'work', action: IAM_ACTIONS.ec2Describe });
    expect(e).toBeInstanceOf(AccessDeniedError);
    expect(e.hint).toContain('ec2:DescribeInstances');
    expect(e.hint).not.toContain('ecs:');
  });

  test('TargetNotConnectedException points at the task role and the exec agent', () => {
    const e = describeAwsError(named('TargetNotConnectedException'), ctx);
    expect(e.message).toBe('The container is not reachable through ECS Exec');
    expect(e.hint).toContain('ssmmessages');
  });

  test('InvalidParameterException about execute command explains enableExecuteCommand', () => {
    const err = Object.assign(
      new Error(
        'The execute command failed because execute command was not enabled when the task was run or the execute command agent isn’t running. Wait and try again or run a new task with execute command enabled and try again.',
      ),
      { name: 'InvalidParameterException' },
    );
    const e = describeAwsError(err, ctx);
    expect(e.message).toBe('ECS Exec is not enabled for this task');
    expect(e.hint).toContain('enableExecuteCommand');
  });

  test('other InvalidParameterExceptions keep their message', () => {
    const e = describeAwsError(named('InvalidParameterException'), ctx);
    expect(e.message).toBe('InvalidParameterException happened');
  });
});
