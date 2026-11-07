import { describe, expect, test, vi } from 'vitest';
import type { ServiceSummary, TaskDefinitionSummary, TaskRow } from '../../src/aws/ecs.js';
import {
  type DoctorDeps,
  type EcsDoctorDeps,
  renderDoctorReport,
  runDoctor,
  runDoctorChecks,
  SSMMESSAGES_ACTIONS,
} from '../../src/commands/doctor.js';
import { CliError } from '../../src/errors.js';
import type { AwsContext } from '../../src/types.js';

const ctx: AwsContext = {
  profile: 'default',
  region: 'ap-northeast-2',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
};

const TASK_ID = '7b2e9f0a1c3d4e5f60718293a4b5c6d7';
const ROLE = 'arn:aws:iam::123456789012:role/api-task';
const service = (over: Partial<ServiceSummary> = {}): ServiceSummary => ({
  name: 'api',
  arn: 'arn:x/api',
  desired: 2,
  running: 2,
  launchType: 'FARGATE',
  taskDefinition: 'api:42',
  execEnabled: true,
  status: 'ACTIVE',
  ...over,
});
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  taskId: TASK_ID,
  arn: `arn:x/${TASK_ID}`,
  cluster: 'prod',
  service: 'api',
  lastStatus: 'RUNNING',
  health: 'HEALTHY',
  launchType: 'FARGATE',
  platformVersion: '1.4.0',
  startedAt: new Date('2026-11-08T00:00:00Z'),
  availabilityZone: 'ap-northeast-2a',
  execEnabled: true,
  taskDefinition: 'api:42',
  taskDefinitionArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:42',
  containers: [{ name: 'app', runtimeId: 'rt', lastStatus: 'RUNNING', agentStatus: 'RUNNING' }],
  agentStatus: 'RUNNING',
  connectable: true,
  reason: null,
  ...over,
});
const allowAll = Object.fromEntries(SSMMESSAGES_ACTIONS.map((a) => [a, 'allowed']));

function fakeEcs(over: Partial<EcsDoctorDeps> = {}): EcsDoctorDeps {
  return {
    ecsClient: vi.fn(async () => ({ send: vi.fn() })),
    iamClient: vi.fn(async () => ({ send: vi.fn() })),
    fetchServices: vi.fn(async () => [service()]),
    fetchTasks: vi.fn(async () => [task()]),
    describeTask: vi.fn(async () => task()),
    describeTaskDefinition: vi.fn(
      async (): Promise<TaskDefinitionSummary> => ({
        taskRoleArn: ROLE,
        executionRoleArn: null,
        initProcessEnabled: true,
      }),
    ),
    simulateRole: vi.fn(async () => allowAll),
    ...over,
  };
}

function makeDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    ecs: fakeEcs(),
    nodeVersion: '24.22.2',
    findPluginPath: () => '/opt/homebrew/bin/session-manager-plugin',
    getPluginVersion: async () => '1.2.896.0',
    loadSharedConfig: async () => ({
      credentialsFile: { default: { aws_access_key_id: 'x' }, work: {} },
      configFile: { default: { region: 'ap-northeast-2' } },
    }),
    resolveContext: vi.fn(async () => ctx),
    getCallerIdentity: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/sam' }),
    writeStdout: vi.fn(),
    env: {},
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

  test('resolves the region itself (profile config, else us-east-1) so the check never prompts', async () => {
    const deps = makeDeps();
    await runDoctorChecks({ profile: 'default' }, deps);
    expect(deps.resolveContext).toHaveBeenCalledWith({ profile: 'default', region: 'ap-northeast-2' });
    const noRegion = makeDeps();
    await runDoctorChecks({ profile: 'work' }, noRegion);
    expect(noRegion.resolveContext).toHaveBeenCalledWith({ profile: 'work', region: 'us-east-1' });
    const fromEnv = makeDeps({ env: { AWS_REGION: 'eu-west-1' } });
    await runDoctorChecks({ profile: 'work' }, fromEnv);
    expect(fromEnv.resolveContext).toHaveBeenCalledWith({ profile: 'work', region: 'eu-west-1' });
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

describe('ECS Exec checks (doctor --ecs)', () => {
  const run = (ecs: Partial<EcsDoctorDeps> = {}, target = 'prod/api') =>
    runDoctorChecks({ profile: 'default', ecs: target }, makeDeps({ ecs: fakeEcs(ecs) })).then((checks) =>
      checks.slice(4),
    );

  test('a healthy service passes all four checks', async () => {
    const checks = await run();
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['ECS service prod/api', true],
      ['Task', true],
      ['Exec agent', true],
      ['Task role', true],
    ]);
    expect(checks[0]?.detail).toContain('execute command enabled');
    expect(checks[1]?.detail).toContain(TASK_ID);
    expect(checks[1]?.detail).toContain('FARGATE 1.4.0');
    expect(checks[2]?.detail).toContain('RUNNING in app');
    expect(checks[3]?.detail).toContain('api-task');
    expect(checks[3]?.detail).toContain('ssmmessages');
  });

  test('--ecs needs --profile', async () => {
    await expect(runDoctorChecks({ ecs: 'prod/api' }, makeDeps())).rejects.toBeInstanceOf(CliError);
    await expect(runDoctorChecks({ profile: 'default', ecs: 'api' }, makeDeps())).rejects.toThrow(/cluster\/service/);
  });

  test('a service without execute command fails with the update-service hint', async () => {
    const [svc] = await run({ fetchServices: vi.fn(async () => [service({ execEnabled: false })]) });
    expect(svc).toMatchObject({ ok: false });
    expect(svc?.detail).toContain('--enable-execute-command --force-new-deployment');
  });

  test('a missing service and a service without running tasks are reported', async () => {
    const [missing] = await run({ fetchServices: vi.fn(async () => []) });
    expect(missing).toMatchObject({ ok: false, detail: expect.stringContaining('not found in cluster "prod"') });
    const checks = await run({ fetchTasks: vi.fn(async () => []) });
    expect(checks[1]).toMatchObject({ name: 'Task', ok: false, detail: expect.stringContaining('no running tasks') });
    expect(checks).toHaveLength(2); // agent and role checks need a task
  });

  test('task problems: exec disabled, old platform version, not running', async () => {
    const disabled = await run({ fetchTasks: vi.fn(async () => [task({ execEnabled: false })]) });
    expect(disabled[1]).toMatchObject({ ok: false, detail: expect.stringContaining('exec disabled') });
    const old = await run({ fetchTasks: vi.fn(async () => [task({ platformVersion: '1.3.0' })]) });
    expect(old[1]).toMatchObject({ ok: false, detail: expect.stringContaining('1.4.0') });
    const pending = await run({ fetchTasks: vi.fn(async () => [task({ lastStatus: 'PENDING' })]) });
    expect(pending[1]).toMatchObject({ ok: false, detail: expect.stringContaining('PENDING') });
  });

  test('a pending or missing exec agent fails', async () => {
    const pending = await run({
      fetchTasks: vi.fn(async () => [
        task({
          containers: [{ name: 'app', runtimeId: null, lastStatus: 'RUNNING', agentStatus: 'PENDING' }],
          agentStatus: 'PENDING',
        }),
      ]),
    });
    expect(pending[2]).toMatchObject({
      name: 'Exec agent',
      ok: false,
      detail: expect.stringContaining('PENDING in app'),
    });
    const none = await run({
      fetchTasks: vi.fn(async () => [
        task({
          containers: [{ name: 'app', runtimeId: null, lastStatus: 'RUNNING', agentStatus: null }],
          agentStatus: null,
        }),
      ]),
    });
    expect(none[2]).toMatchObject({ ok: false, detail: expect.stringContaining('no ExecuteCommandAgent') });
  });

  test('task role: missing, lacking an action, or unverifiable', async () => {
    const missing = await run({
      describeTaskDefinition: vi.fn(async () => ({
        taskRoleArn: null,
        executionRoleArn: null,
        initProcessEnabled: false,
      })),
    });
    expect(missing[3]).toMatchObject({ name: 'Task role', ok: false, detail: expect.stringContaining('no task role') });

    const lacking = await run({
      simulateRole: vi.fn(async () => ({ ...allowAll, 'ssmmessages:OpenDataChannel': 'implicitDeny' })),
    });
    expect(lacking[3]).toMatchObject({ ok: false, detail: expect.stringContaining('ssmmessages:OpenDataChannel') });
    expect(lacking[3]?.detail).not.toContain('CreateControlChannel');

    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    const unverifiable = await run({ simulateRole: vi.fn(async () => Promise.reject(denied)) });
    expect(unverifiable[3]).toMatchObject({ ok: true, warning: true });
    expect(unverifiable[3]?.detail).toContain('could not verify');
    expect(unverifiable[3]?.detail).toContain('api-task');
  });

  test('a specific task id is checked instead of the newest one', async () => {
    const ecs = fakeEcs();
    await runDoctorChecks({ profile: 'default', ecs: `prod/api/${TASK_ID}` }, makeDeps({ ecs }));
    expect(ecs.describeTask).toHaveBeenCalledWith(expect.anything(), 'prod', TASK_ID);
    expect(ecs.fetchTasks).not.toHaveBeenCalled();
  });

  test('an AWS error while checking becomes a single failed check', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    const checks = await run({ fetchServices: vi.fn(async () => Promise.reject(denied)) });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ ok: false, detail: expect.stringContaining('not allowed') });
  });

  test('renderDoctorReport marks warnings with !', () => {
    const out = renderDoctorReport([
      { name: 'A', ok: true, detail: 'fine' },
      { name: 'B', ok: true, warning: true, detail: 'unverified' },
      { name: 'C', ok: false, detail: 'bad' },
    ]);
    expect(out).toBe('✔ A: fine\n! B: unverified\n✘ C: bad\n');
  });
});
