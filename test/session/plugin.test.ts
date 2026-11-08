import { describe, expect, test } from 'vitest';
import {
  buildPluginInvocation,
  compareVersions,
  ENV_VAR_MIN_VERSION,
  findPluginPath,
  getPluginVersion,
  PLUGIN_ENV_VAR,
  parseVersionOutput,
  pluginFileNames,
  RECOMMENDED_MIN_VERSION,
} from '../../src/session/plugin.js';
import { CliError } from '../../src/errors.js';
import type { SessionStart } from '../../src/types.js';

const session: SessionStart = { SessionId: 's-1', StreamUrl: 'wss://x', TokenValue: 'tok' };
const base = {
  session,
  region: 'ap-northeast-2',
  profile: 'default',
  parameters: { Target: 'i-1' },
  endpoint: 'https://ssm.ap-northeast-2.amazonaws.com',
  baseEnv: { PATH: '/bin' },
};

describe('pluginFileNames', () => {
  test('win32 tries .exe and .cmd before the bare name', () => {
    expect(pluginFileNames('win32')).toEqual([
      'session-manager-plugin.exe',
      'session-manager-plugin.cmd',
      'session-manager-plugin',
    ]);
    expect(pluginFileNames('darwin')).toEqual(['session-manager-plugin']);
  });
});

describe('findPluginPath', () => {
  test('prefers SSM_COMMANDER_PLUGIN_PATH when it exists', () => {
    const exists = (p: string) => p === '/opt/custom/plugin' || p === '/usr/local/bin/session-manager-plugin';
    expect(
      findPluginPath({
        env: { SSM_COMMANDER_PLUGIN_PATH: '/opt/custom/plugin', PATH: '/usr/local/bin' },
        platform: 'darwin',
        exists,
      }),
    ).toBe('/opt/custom/plugin');
  });

  test('refuses an SSM_COMMANDER_PLUGIN_PATH that does not exist instead of silently using PATH', () => {
    const exists = (p: string) => p === '/usr/local/bin/session-manager-plugin';
    const lookup = () =>
      findPluginPath({
        env: { SSM_COMMANDER_PLUGIN_PATH: '/nope', PATH: '/usr/local/bin' },
        platform: 'darwin',
        exists,
      });
    expect(lookup).toThrow(CliError);
    expect(lookup).toThrow('SSM_COMMANDER_PLUGIN_PATH points to "/nope", which does not exist');
  });

  test('scans PATH directories in order on posix', () => {
    const exists = (p: string) => p === '/usr/bin/session-manager-plugin' || p === '/opt/bin/session-manager-plugin';
    expect(findPluginPath({ env: { PATH: '/home/me/bin:/opt/bin:/usr/bin' }, platform: 'linux', exists })).toBe(
      '/opt/bin/session-manager-plugin',
    );
  });

  test('tries .exe first on win32 and splits Path with ";"', () => {
    const exists = (p: string) => p === 'C:\\tools\\session-manager-plugin.exe';
    expect(findPluginPath({ env: { Path: 'C:\\Windows;C:\\tools' }, platform: 'win32', exists })).toBe(
      'C:\\tools\\session-manager-plugin.exe',
    );
  });

  test('returns null when nothing matches', () => {
    expect(findPluginPath({ env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false })).toBeNull();
    expect(findPluginPath({ env: {}, platform: 'linux', exists: () => true })).toBeNull();
  });
});

describe('versions', () => {
  test('parseVersionOutput extracts 1.2.896.0 and returns null for garbage', () => {
    expect(parseVersionOutput('1.2.896.0\n')).toBe('1.2.896.0');
    expect(parseVersionOutput('session-manager-plugin version 1.2.764.0')).toBe('1.2.764.0');
    expect(parseVersionOutput('no version here')).toBeNull();
  });

  test('compareVersions orders dotted versions numerically', () => {
    expect(compareVersions('1.2.497.0', '1.2.500.0')).toBeLessThan(0);
    expect(compareVersions('1.2.500.0', '1.10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0.0', '1.2.500.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.497.0', '1.2.497.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0.0')).toBe(0);
    expect(compareVersions(RECOMMENDED_MIN_VERSION, ENV_VAR_MIN_VERSION)).toBeGreaterThan(0);
  });

  test('getPluginVersion runs --version and parses the output; null when the executable fails', async () => {
    expect(await getPluginVersion(process.execPath)).toBe(process.versions.node);
    expect(await getPluginVersion('/nonexistent/session-manager-plugin')).toBeNull();
  });
});

describe('buildPluginInvocation', () => {
  test('uses the env var when version > 1.2.497.0', () => {
    const inv = buildPluginInvocation({ ...base, pluginVersion: '1.2.896.0' });
    expect(inv.args).toEqual([
      'AWS_SSM_START_SESSION_RESPONSE',
      'ap-northeast-2',
      'StartSession',
      'default',
      '{"Target":"i-1"}',
      'https://ssm.ap-northeast-2.amazonaws.com',
    ]);
    expect(inv.env[PLUGIN_ENV_VAR]).toBe(JSON.stringify(session));
    expect(inv.env.PATH).toBe('/bin');
  });

  test('passes the session JSON as args[0] only for plugins at or below 1.2.497.0', () => {
    const inv = buildPluginInvocation({ ...base, pluginVersion: '1.2.497.0' });
    expect(inv.args[0]).toBe(JSON.stringify(session));
    expect(inv.env[PLUGIN_ENV_VAR]).toBeUndefined();
    expect(inv.env.PATH).toBe('/bin');
  });

  test('uses the env var when the plugin version is unknown, so the token never reaches argv by default', () => {
    const inv = buildPluginInvocation({ ...base, pluginVersion: null });
    expect(inv.args[0]).toBe(PLUGIN_ENV_VAR);
    expect(inv.env[PLUGIN_ENV_VAR]).toBe(JSON.stringify(session));
  });

  test('keeps a profile name with spaces as a single argv element and serialises all parameters', () => {
    const inv = buildPluginInvocation({
      ...base,
      profile: 'my work profile',
      parameters: { Target: 'i-1', DocumentName: 'AWS-StartSSHSession', Parameters: { portNumber: ['22'] } },
      pluginVersion: '1.2.896.0',
    });
    expect(inv.args[3]).toBe('my work profile');
    expect(JSON.parse(inv.args[4] as string)).toEqual({
      Target: 'i-1',
      DocumentName: 'AWS-StartSSHSession',
      Parameters: { portNumber: ['22'] },
    });
    expect(inv.args).toHaveLength(6);
  });
});
