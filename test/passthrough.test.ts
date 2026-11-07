import { describe, expect, test } from 'vitest';
import { CliError } from '../src/errors.js';
import {
  buildProxyCommand,
  buildScpArgs,
  buildSshArgs,
  DEFAULT_SSH_USER,
  findScpRemoteOperand,
  selfCommand,
  splitSshRest,
} from '../src/passthrough.js';

const proxy =
  '"/usr/local/bin/node" "/opt/s c/cli.mjs" proxy --profile default --region ap-northeast-2 --target i-1 --port 22';

describe('selfCommand / buildProxyCommand', () => {
  test('selfCommand is the running node binary plus the entry script', () => {
    expect(
      selfCommand({ execPath: '/usr/local/bin/node', argv: ['/usr/local/bin/node', '/opt/cli.mjs', 'ssh'] }),
    ).toEqual(['/usr/local/bin/node', '/opt/cli.mjs']);
  });

  test('buildProxyCommand quotes each element and names the proxy subcommand', () => {
    expect(
      buildProxyCommand(['/usr/local/bin/node', '/opt/s c/cli.mjs'], {
        profile: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-1',
        port: 22,
      }),
    ).toBe(proxy);
  });
});

describe('ssh arguments', () => {
  test('splitSshRest keeps -o values with options and starts the command at the first non-option', () => {
    expect(splitSshRest(['-o', 'StrictHostKeyChecking=accept-new', '-v', 'hostname', '-a'])).toEqual({
      options: ['-o', 'StrictHostKeyChecking=accept-new', '-v'],
      command: ['hostname', '-a'],
    });
    expect(splitSshRest([])).toEqual({ options: [], command: [] });
    expect(splitSshRest(['-L', '8080:localhost:80', '-N'])).toEqual({
      options: ['-L', '8080:localhost:80', '-N'],
      command: [],
    });
  });

  test('buildSshArgs orders ProxyCommand, user, identity, port, passthrough options, host, command', () => {
    expect(
      buildSshArgs({
        own: { user: 'ubuntu', identity: '~/.ssh/key.pem', port: 2222 },
        instanceId: 'i-1',
        proxyCommand: proxy,
        rest: ['-o', 'StrictHostKeyChecking=accept-new', 'hostname', '-f'],
      }),
    ).toEqual([
      '-o',
      `ProxyCommand=${proxy}`,
      '-l',
      'ubuntu',
      '-i',
      '~/.ssh/key.pem',
      '-p',
      '2222',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'i-1',
      'hostname',
      '-f',
    ]);
  });

  test('buildSshArgs defaults the user to ec2-user', () => {
    expect(DEFAULT_SSH_USER).toBe('ec2-user');
    expect(buildSshArgs({ own: {}, instanceId: 'i-1', proxyCommand: proxy, rest: [] })).toEqual([
      '-o',
      `ProxyCommand=${proxy}`,
      '-l',
      'ec2-user',
      'i-1',
    ]);
  });
});

describe('scp arguments', () => {
  test('findScpRemoteOperand finds user@name:path and reports index', () => {
    expect(findScpRemoteOperand(['-r', './dir', 'ubuntu@web-1:/tmp'])).toEqual({
      index: 2,
      user: 'ubuntu',
      target: 'web-1',
      path: '/tmp',
    });
    expect(findScpRemoteOperand(['web-1:', './x'])).toEqual({ index: 0, user: null, target: 'web-1', path: '' });
  });

  test('findScpRemoteOperand skips option values that contain colons', () => {
    expect(findScpRemoteOperand(['-o', 'ProxyCommand=a:b', 'web-1:/x', './y']).target).toBe('web-1');
    expect(findScpRemoteOperand(['-P', '2222', './y', 'web-1:/x']).index).toBe(3);
  });

  test('findScpRemoteOperand throws for zero or two remote operands', () => {
    expect(() => findScpRemoteOperand(['./a', './b'])).toThrow(CliError);
    expect(() => findScpRemoteOperand(['./a', './b'])).toThrow(
      'scp needs exactly one remote operand like user@instance-name:/path',
    );
    expect(() => findScpRemoteOperand(['a:/x', 'b:/y'])).toThrow('scp between two remote instances is not supported');
  });

  test('buildScpArgs replaces the remote operand with instanceId:path and sets User from the operand, then --user, then ec2-user', () => {
    const args = ['-r', './dir', 'ubuntu@web-1:/tmp'];
    const remote = findScpRemoteOperand(args);
    expect(buildScpArgs({ own: { user: 'ignored' }, proxyCommand: proxy, args, remote, instanceId: 'i-1' })).toEqual([
      '-o',
      `ProxyCommand=${proxy}`,
      '-o',
      'User=ubuntu',
      '-r',
      './dir',
      'i-1:/tmp',
    ]);
    const plain = ['web-1:/etc/hosts', './hosts'];
    const plainRemote = findScpRemoteOperand(plain);
    expect(
      buildScpArgs({
        own: { user: 'admin', identity: 'k.pem', port: 2222 },
        proxyCommand: proxy,
        args: plain,
        remote: plainRemote,
        instanceId: 'i-1',
      }),
    ).toEqual([
      '-o',
      `ProxyCommand=${proxy}`,
      '-o',
      'User=admin',
      '-i',
      'k.pem',
      '-P',
      '2222',
      'i-1:/etc/hosts',
      './hosts',
    ]);
    expect(buildScpArgs({ own: {}, proxyCommand: proxy, args: plain, remote: plainRemote, instanceId: 'i-1' })[3]).toBe(
      'User=ec2-user',
    );
  });
});

describe('assertOwnOptionsFirst', () => {
  test('rejects ssm-commander options that would be passed through to ssh/scp', async () => {
    const { assertOwnOptionsFirst } = await import('../src/passthrough.js');
    expect(() => assertOwnOptionsFirst(['-o', 'X=y', '--profile', 'default'])).toThrow(CliError);
    expect(() => assertOwnOptionsFirst(['--user=ubuntu'])).toThrow(
      'Option --user must come before the target; after it, arguments are passed to ssh/scp unchanged',
    );
    expect(() => assertOwnOptionsFirst(['-o', 'StrictHostKeyChecking=no', 'hostname', '--verbose'])).not.toThrow();
  });
});
