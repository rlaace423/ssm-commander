import { describe, expect, test } from 'vitest';
import { COMMAND_NAMES, editDistance, suggestCommand } from '../src/suggest.js';

describe('editDistance', () => {
  test('counts insertions, deletions, substitutions and adjacent transpositions as one edit each', () => {
    expect(editDistance('connect', 'connect')).toBe(0);
    expect(editDistance('conect', 'connect')).toBe(1);
    expect(editDistance('connectt', 'connect')).toBe(1);
    expect(editDistance('cannect', 'connect')).toBe(1);
    expect(editDistance('exce', 'exec')).toBe(1);
    expect(editDistance('shh', 'ssh')).toBe(1);
    expect(editDistance('', 'ssh')).toBe(3);
    expect(editDistance('doctor', 'forward')).toBeGreaterThan(2);
  });
});

describe('suggestCommand', () => {
  test('knows every public command', () => {
    expect(COMMAND_NAMES).toEqual(['connect', 'exec', 'forward', 'ssh', 'scp', 'doctor']);
  });

  test('suggests the closest command for small typos', () => {
    expect(suggestCommand('conect')).toBe('connect');
    expect(suggestCommand('Connect')).toBe('connect');
    expect(suggestCommand('exce')).toBe('exec');
    expect(suggestCommand('fowrard')).toBe('forward');
    expect(suggestCommand('docter')).toBe('doctor');
    expect(suggestCommand('shh')).toBe('ssh');
  });

  test('returns null for words that are not close to a command, including instance-like names', () => {
    expect(suggestCommand('web-1')).toBeNull();
    expect(suggestCommand('nonsense')).toBeNull();
    expect(suggestCommand('i-0123456789abcdef0')).toBeNull();
    expect(suggestCommand('sh')).toBeNull(); // too short to tell ssh from scp
    expect(suggestCommand('api')).toBeNull();
    expect(suggestCommand('connect')).toBeNull(); // an exact command name is dispatched as a command, never suggested
  });
});
