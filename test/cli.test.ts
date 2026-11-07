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
});
