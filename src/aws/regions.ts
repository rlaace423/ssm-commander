import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { Sender } from '../types.js';
import { createEc2Client } from './clients.js';

/** Fallback when DescribeRegions cannot be called; kept sorted. */
export const STATIC_REGIONS: string[] = [
  'af-south-1',
  'ap-east-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
];

export async function listRegions(
  credentials: AwsCredentialIdentityProvider,
  deps: { ec2?: Sender } = {},
): Promise<string[]> {
  try {
    const { DescribeRegionsCommand } = await import('@aws-sdk/client-ec2');
    const ec2 = deps.ec2 ?? (await createEc2Client({ profile: '', region: 'us-east-1', credentials }));
    const output = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
    const names = ((output.Regions ?? []) as Array<{ RegionName?: string }>)
      .map((region) => region.RegionName)
      .filter((name): name is string => typeof name === 'string')
      .sort();
    return names.length > 0 ? names : STATIC_REGIONS;
  } catch {
    return STATIC_REGIONS;
  }
}
