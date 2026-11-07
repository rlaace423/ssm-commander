import { describe, expect, test, vi } from 'vitest';
import { simulateRole } from '../../src/aws/iam.js';

describe('simulateRole', () => {
  test('maps every evaluated action to its decision', async () => {
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      expect(cmd.constructor.name).toBe('SimulatePrincipalPolicyCommand');
      expect(cmd.input).toEqual({ PolicySourceArn: 'arn:role/task', ActionNames: ['a:One', 'a:Two'] });
      return {
        EvaluationResults: [
          { EvalActionName: 'a:One', EvalDecision: 'allowed' },
          { EvalActionName: 'a:Two', EvalDecision: 'implicitDeny' },
        ],
      };
    });
    expect(await simulateRole({ send }, 'arn:role/task', ['a:One', 'a:Two'])).toEqual({
      'a:One': 'allowed',
      'a:Two': 'implicitDeny',
    });
  });
});
