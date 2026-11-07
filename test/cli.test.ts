import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createProgram } from '../src/cli.js';

describe('createProgram', () => {
  test('uses package name and version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const program = createProgram();
    expect(program.name()).toBe('ssm-commander');
    expect(program.version()).toBe(pkg.version);
  });

  test('registers connect as the default command with its options', () => {
    const program = createProgram();
    const connect = program.commands.find((c) => c.name() === 'connect');
    expect(connect).toBeDefined();
    expect((program as unknown as { _defaultCommandName?: string })._defaultCommandName).toBe('connect');
    const flags = connect?.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--profile', '--region', '--connectable']));
    expect(program.options.map((o) => o.long)).toContain('--debug');
  });

  test('registers ssh and scp with pass-through and a hidden proxy command', () => {
    const program = createProgram();
    for (const name of ['ssh', 'scp']) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd).toBeDefined();
      expect(cmd?.options.map((o) => o.long)).toEqual(
        expect.arrayContaining(['--profile', '--region', '--user', '--identity', '--port', '--connectable']),
      );
      expect(cmd?.options.map((o) => o.short).filter(Boolean)).toEqual([]);
      expect((cmd as unknown as { _passThroughOptions: boolean })._passThroughOptions).toBe(true);
      expect((cmd as unknown as { _allowUnknownOption: boolean })._allowUnknownOption).toBe(true);
    }
    const proxy = program.commands.find((c) => c.name() === 'proxy');
    expect((proxy as unknown as { _hidden: boolean })._hidden).toBe(true);
    expect(proxy?.options.filter((o) => o.required).map((o) => o.long)).toEqual(
      expect.arrayContaining(['--profile', '--region', '--target', '--port']),
    );
  });

  test('registers doctor with a profile option', () => {
    const doctor = createProgram().commands.find((c) => c.name() === 'doctor');
    expect(doctor?.options.map((o) => o.long)).toEqual(['--profile']);
  });

  test('registers forward with preset management options', () => {
    const forward = createProgram().commands.find((c) => c.name() === 'forward');
    expect(forward?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--target',
        '--remote-host',
        '--remote-port',
        '--local-port',
        '--save',
        '--list',
        '--delete',
      ]),
    );
  });
});
