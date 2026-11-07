import type { EC2Client } from '@aws-sdk/client-ec2';
import type { ECSClient } from '@aws-sdk/client-ecs';
import type { IAMClient } from '@aws-sdk/client-iam';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import type { AwsContext } from '../types.js';

function clientConfig(ctx: AwsContext) {
  return { region: ctx.region, credentials: ctx.credentials };
}

export function createSsmClient(ctx: AwsContext): SSMClient {
  return new SSMClient(clientConfig(ctx));
}

/** The EC2 client is large, so it is loaded only when an instance list is needed. */
export async function createEc2Client(ctx: AwsContext): Promise<EC2Client> {
  const { EC2Client } = await import('@aws-sdk/client-ec2');
  return new EC2Client(clientConfig(ctx));
}

/** Loaded on demand like EC2; only the exec command needs it. */
export async function createEcsClient(ctx: AwsContext): Promise<ECSClient> {
  const { ECSClient } = await import('@aws-sdk/client-ecs');
  return new ECSClient(clientConfig(ctx));
}

/** Only `doctor --ecs` needs IAM (to simulate the task role's policies). */
export async function createIamClient(ctx: AwsContext): Promise<IAMClient> {
  const { IAMClient } = await import('@aws-sdk/client-iam');
  return new IAMClient(clientConfig(ctx));
}

export function createStsClient(ctx: AwsContext): STSClient {
  return new STSClient(clientConfig(ctx));
}
