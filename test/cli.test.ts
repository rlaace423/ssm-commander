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
});
