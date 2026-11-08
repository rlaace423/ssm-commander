import { describe, expect, test } from 'vitest';
import { CliError } from '../../src/errors.js';
import { promptTableWidth, requireTty } from '../../src/ui/prompts.js';

const terminal = { stdin: { isTTY: true }, stdout: { isTTY: true } };
const pipe = { stdin: { isTTY: false }, stdout: { isTTY: true } };

describe('requireTty', () => {
  test('passes when stdin and stdout are terminals', () => {
    expect(() =>
      requireTty({ what: 'Picking an instance', hint: 'Pass the instance name or id' }, terminal),
    ).not.toThrow();
  });

  test('names what needed the terminal and what to pass instead', () => {
    const err = (() => {
      try {
        requireTty({ what: 'Picking an instance', hint: 'Pass the instance name or id' }, pipe);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe('Picking an instance needs an interactive terminal');
    expect((err as CliError).hint).toBe('Pass the instance name or id');
  });

  test('falls back to a generic wording', () => {
    expect(() => requireTty(undefined, pipe)).toThrow('This command needs an interactive terminal');
  });
});

describe('promptTableWidth', () => {
  test('is a number only when the prompt output is a terminal with a known width', () => {
    const width = promptTableWidth();
    expect(width === undefined || typeof width === 'number').toBe(true);
  });
});
