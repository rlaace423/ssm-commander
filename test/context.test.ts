import type { SharedConfigFiles } from '@smithy/types';
import { describe, expect, test, vi } from 'vitest';
import { type ContextDeps, resolveContext } from '../src/context.js';
import { CliError } from '../src/errors.js';

const files: SharedConfigFiles = {
  credentialsFile: { default: { aws_access_key_id: 'a' }, work: { aws_access_key_id: 'b' } },
  configFile: { work: { region: 'us-west-2' } },
};
const provider = async () => ({ accessKeyId: 'k', secretAccessKey: 's' });

function makeDeps(over: Partial<ContextDeps> = {}): ContextDeps {
  return {
    loadSharedConfig: vi.fn(async () => files),
    promptProfile: vi.fn(async () => 'work'),
    promptRegion: vi.fn(async () => 'eu-west-1'),
    listRegions: vi.fn(async () => ['eu-west-1', 'us-east-1']),
    requireTty: vi.fn(),
    env: {},
    credentialsFor: vi.fn(() => provider),
    promptMfaCode: vi.fn(async () => '123456'),
    ...over,
  };
}

describe('resolveContext', () => {
  test('uses --profile and --region without prompting', async () => {
    const deps = makeDeps();
    const ctx = await resolveContext({ profile: 'work', region: 'ap-northeast-2' }, deps);
    expect(ctx).toEqual({ profile: 'work', region: 'ap-northeast-2', credentials: provider });
    expect(deps.promptProfile).not.toHaveBeenCalled();
    expect(deps.promptRegion).not.toHaveBeenCalled();
    expect(deps.requireTty).not.toHaveBeenCalled();
    expect(deps.credentialsFor).toHaveBeenCalledWith('work', expect.any(Function));
  });

  test('prompts for profile when several profiles exist and nothing is set', async () => {
    const deps = makeDeps();
    const ctx = await resolveContext({}, deps);
    expect(deps.requireTty).toHaveBeenCalled();
    expect(deps.promptProfile).toHaveBeenCalledWith(['default', 'work']);
    expect(ctx.profile).toBe('work');
    expect(ctx.region).toBe('us-west-2');
  });

  test('honours AWS_PROFILE without prompting', async () => {
    const deps = makeDeps({ env: { AWS_PROFILE: 'work' } });
    const ctx = await resolveContext({}, deps);
    expect(deps.promptProfile).not.toHaveBeenCalled();
    expect(ctx.profile).toBe('work');
  });

  test('uses the profile region from config without prompting', async () => {
    const deps = makeDeps();
    const ctx = await resolveContext({ profile: 'work' }, deps);
    expect(ctx.region).toBe('us-west-2');
    expect(deps.promptRegion).not.toHaveBeenCalled();
    expect(deps.listRegions).not.toHaveBeenCalled();
  });

  test('prompts for region when none can be resolved', async () => {
    const deps = makeDeps();
    const ctx = await resolveContext({ profile: 'default' }, deps);
    expect(deps.requireTty).toHaveBeenCalled();
    expect(deps.listRegions).toHaveBeenCalledWith(provider);
    expect(deps.promptRegion).toHaveBeenCalledWith(['eu-west-1', 'us-east-1']);
    expect(ctx.region).toBe('eu-west-1');
  });

  test('throws CliError when no profiles exist', async () => {
    const deps = makeDeps({ loadSharedConfig: vi.fn(async () => ({ credentialsFile: {}, configFile: {} })) });
    await expect(resolveContext({}, deps)).rejects.toThrow(CliError);
    await expect(resolveContext({}, deps)).rejects.toThrow('No AWS profiles found');
  });

  test('the MFA code prompt handed to credentialsFor requires a TTY first', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('no tty');
      },
    });
    await resolveContext({ profile: 'work' }, deps);
    const mfa = (deps.credentialsFor as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (
      serial: string,
    ) => Promise<string>;
    await expect(mfa('arn:aws:iam::1:mfa/sam')).rejects.toThrow('no tty');
    expect(deps.promptMfaCode).not.toHaveBeenCalled();
    const ok = makeDeps();
    await resolveContext({ profile: 'work' }, ok);
    const mfaOk = (ok.credentialsFor as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (
      serial: string,
    ) => Promise<string>;
    expect(await mfaOk('arn:aws:iam::1:mfa/sam')).toBe('123456');
    expect(ok.promptMfaCode).toHaveBeenCalledWith('arn:aws:iam::1:mfa/sam');
  });

  test('throws CliError from requireTty when a prompt is needed and stdin is not a TTY', async () => {
    const deps = makeDeps({
      requireTty: () => {
        throw new CliError('This command needs an interactive terminal; pass --profile/--region/target explicitly');
      },
    });
    await expect(resolveContext({}, deps)).rejects.toThrow('needs an interactive terminal');
    expect(deps.promptProfile).not.toHaveBeenCalled();
  });
});
