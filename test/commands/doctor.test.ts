import { describe, expect, test, vi } from 'vitest';
import { type DoctorDeps, renderDoctorReport, runDoctor, runDoctorChecks } from '../../src/commands/doctor.js';
import type { AwsContext } from '../../src/types.js';

const ctx: AwsContext = {
  profile: 'default',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};

function makeDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: '24.22.2',
    findPluginPath: () => '/opt/homebrew/bin/session-manager-plugin',
    getPluginVersion: async () => '1.2.896.0',
    loadSharedConfig: async () => ({
      credentialsFile: { default: { aws_access_key_id: 'x' }, work: {} },
      configFile: { default: { region: 'ap-northeast-2' } },
    }),
    resolveContext: async () => ctx,
    getCallerIdentity: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/sam' }),
    writeStdout: vi.fn(),
    ...over,
  };
}

describe('runDoctorChecks', () => {
  test('all checks pass with a healthy environment', async () => {
    const checks = await runDoctorChecks({ profile: 'default' }, makeDeps());
    expect(checks.map((c) => c.name)).toEqual([
      'Node.js',
      'session-manager-plugin',
      'AWS config files',
      'Credentials for "default"',
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[0]?.detail).toContain('24.22.2');
    expect(checks[1]?.detail).toContain('1.2.896.0');
    expect(checks[1]?.detail).toContain('/opt/homebrew/bin/session-manager-plugin');
    expect(checks[2]?.detail).toContain('2 profiles');
    expect(checks[2]?.detail).toContain('default, work');
    expect(checks[3]?.detail).toContain('123456789012');
    expect(checks[3]?.detail).toContain('arn:aws:iam::123456789012:user/sam');
  });

  test('without --profile only the three environment checks run', async () => {
    const deps = makeDeps();
    const checks = await runDoctorChecks({}, deps);
    expect(checks).toHaveLength(3);
    expect(deps.getCallerIdentity).toBeUndefined;
  });

  test('plugin missing is reported as a failure', async () => {
    const [, plugin] = await runDoctorChecks({}, makeDeps({ findPluginPath: () => null }));
    expect(plugin).toMatchObject({ ok: false });
    expect(plugin?.detail).toContain('not found on PATH');
  });

  test('old plugin passes with a warning detail', async () => {
    const [, plugin] = await runDoctorChecks({}, makeDeps({ getPluginVersion: async () => '1.2.500.0' }));
    expect(plugin?.ok).toBe(true);
    expect(plugin?.detail).toContain('older than recommended 1.2.764.0');
  });

  test('old Node.js and missing profiles are failures', async () => {
    const [node] = await runDoctorChecks({}, makeDeps({ nodeVersion: '20.11.1' }));
    expect(node).toMatchObject({ ok: false });
    expect(node?.detail).toContain('22 or newer');
    const [, , files] = await runDoctorChecks(
      {},
      makeDeps({ loadSharedConfig: async () => ({ credentialsFile: {}, configFile: {} }) }),
    );
    expect(files?.ok).toBe(false);
  });

  test('credentials failure is reported with the mapped message', async () => {
    const rejected = Object.assign(new Error('bad'), { name: 'InvalidClientTokenId' });
    const checks = await runDoctorChecks(
      { profile: 'default' },
      makeDeps({ getCallerIdentity: async () => Promise.reject(rejected) }),
    );
    expect(checks[3]).toEqual({
      name: 'Credentials for "default"',
      ok: false,
      detail: 'AWS rejected the credentials of profile "default"',
    });
  });
});

describe('renderDoctorReport / runDoctor', () => {
  test('renderDoctorReport uses ✔ and ✘', () => {
    expect(
      renderDoctorReport([
        { name: 'Node.js', ok: true, detail: 'v24.22.2' },
        { name: 'session-manager-plugin', ok: false, detail: 'not found on PATH' },
      ]),
    ).toBe('✔ Node.js: v24.22.2\n✘ session-manager-plugin: not found on PATH\n');
  });

  test('runDoctor writes the report to stdout and returns 1 when a check fails', async () => {
    const healthy = makeDeps();
    expect(await runDoctor({ profile: 'default' }, healthy)).toBe(0);
    expect(String((healthy.writeStdout as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('✔ Node.js');
    const broken = makeDeps({ findPluginPath: () => null });
    expect(await runDoctor({}, broken)).toBe(1);
  });
});
