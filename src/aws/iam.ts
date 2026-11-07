import type { Sender } from '../types.js';

/** Asks IAM whether `roleArn` may perform each action; returns action → decision (`allowed`, `implicitDeny`, ...). */
export async function simulateRole(iam: Sender, roleArn: string, actions: string[]): Promise<Record<string, string>> {
  const { SimulatePrincipalPolicyCommand } = await import('@aws-sdk/client-iam');
  const response = await iam.send(
    new SimulatePrincipalPolicyCommand({ PolicySourceArn: roleArn, ActionNames: actions }),
  );
  const results: Array<{ EvalActionName?: string; EvalDecision?: string }> = response?.EvaluationResults ?? [];
  return Object.fromEntries(results.map((r) => [r.EvalActionName ?? '', r.EvalDecision ?? 'unknown']));
}
