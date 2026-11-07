import { DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import type { AwsContext, InstanceRow, Sender, SsmStatus } from '../types.js';
import { createEc2Client, createSsmClient } from './clients.js';

export interface Ec2Summary {
  instanceId: string;
  name: string | null;
  state: string;
  instanceType: string | null;
  privateIp: string | null;
  publicIp: string | null;
}

export interface SsmSummary {
  instanceId: string;
  pingStatus: 'Online' | 'ConnectionLost' | 'Inactive';
  platformName: string | null;
  computerName: string | null;
}

/** Every EC2 state except terminated and shutting-down. */
export const EC2_STATES = ['pending', 'running', 'stopping', 'stopped'];

export async function fetchEc2Instances(ec2: Sender): Promise<Ec2Summary[]> {
  const { DescribeInstancesCommand } = await import('@aws-sdk/client-ec2');
  const result: Ec2Summary[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: 'instance-state-name', Values: EC2_STATES }],
        MaxResults: 1000,
        NextToken: nextToken,
      }),
    );
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        result.push({
          instanceId: instance.InstanceId ?? '',
          name: instance.Tags?.find((tag: { Key?: string; Value?: string }) => tag.Key === 'Name')?.Value ?? null,
          state: instance.State?.Name ?? 'unknown',
          instanceType: instance.InstanceType ?? null,
          privateIp: instance.PrivateIpAddress ?? null,
          publicIp: instance.PublicIpAddress ?? null,
        });
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return result;
}

export async function fetchSsmInstances(ssm: Sender): Promise<SsmSummary[] | 'unavailable'> {
  const result: SsmSummary[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const page = await ssm.send(new DescribeInstanceInformationCommand({ MaxResults: 50, NextToken: nextToken }));
      for (const info of page.InstanceInformationList ?? []) {
        result.push({
          instanceId: info.InstanceId ?? '',
          pingStatus: (info.PingStatus as SsmSummary['pingStatus']) ?? 'ConnectionLost',
          platformName: info.PlatformName ?? null,
          computerName: info.ComputerName ?? null,
        });
      }
      nextToken = page.NextToken;
    } while (nextToken);
  } catch (err) {
    if ((err as Error).name === 'AccessDeniedException') return 'unavailable';
    throw err;
  }
  return result;
}

function reasonFor(state: string, ssm: SsmStatus): string | null {
  if (state !== 'running' && state !== 'unknown') return state;
  switch (ssm) {
    case 'Online':
    case 'unknown':
      return null;
    case 'None':
      return 'no SSM agent';
    case 'ConnectionLost':
      return 'connection lost';
    case 'Inactive':
      return 'agent inactive';
  }
}

export function mergeInstances(ec2: Ec2Summary[], ssm: SsmSummary[] | 'unavailable'): InstanceRow[] {
  const ssmById = new Map(ssm === 'unavailable' ? [] : ssm.map((s) => [s.instanceId, s]));
  const rows: InstanceRow[] = ec2.map((e) => {
    const info = ssmById.get(e.instanceId);
    const status: SsmStatus = ssm === 'unavailable' ? 'unknown' : (info?.pingStatus ?? 'None');
    const reason = reasonFor(e.state, status);
    return {
      instanceId: e.instanceId,
      name: e.name,
      state: e.state,
      ssm: status,
      instanceType: e.instanceType,
      privateIp: e.privateIp,
      publicIp: e.publicIp,
      platform: info?.platformName ?? null,
      connectable: reason === null,
      reason,
    };
  });
  // SSM-managed nodes that are not EC2 instances (hybrid activations, mi-...)
  const ec2Ids = new Set(ec2.map((e) => e.instanceId));
  if (ssm !== 'unavailable') {
    for (const info of ssm) {
      if (ec2Ids.has(info.instanceId)) continue;
      const reason = reasonFor('unknown', info.pingStatus);
      rows.push({
        instanceId: info.instanceId,
        name: info.computerName,
        state: 'unknown',
        ssm: info.pingStatus,
        instanceType: null,
        privateIp: null,
        publicIp: null,
        platform: info.platformName,
        connectable: reason === null,
        reason,
      });
    }
  }
  return rows;
}

function compareByName(a: InstanceRow, b: InstanceRow): number {
  if (a.name === null && b.name !== null) return 1;
  if (a.name !== null && b.name === null) return -1;
  const byName = (a.name ?? '').localeCompare(b.name ?? '');
  return byName !== 0 ? byName : a.instanceId.localeCompare(b.instanceId);
}

export function sortInstances(rows: InstanceRow[], recentIds: string[]): InstanceRow[] {
  const recent = recentIds
    .map((id) => rows.find((r) => r.instanceId === id))
    .filter((r): r is InstanceRow => r !== undefined);
  const rest = rows.filter((r) => !recentIds.includes(r.instanceId));
  return [
    ...recent,
    ...rest.filter((r) => r.connectable).sort(compareByName),
    ...rest.filter((r) => !r.connectable).sort(compareByName),
  ];
}

export function filterConnectable(rows: InstanceRow[]): InstanceRow[] {
  return rows.filter((r) => r.connectable);
}

export async function listInstances(
  ctx: AwsContext,
  opts: { recentIds: string[]; connectableOnly: boolean },
  deps: { ssm?: Sender; ec2?: Sender } = {},
): Promise<{ rows: InstanceRow[]; ssmUnavailable: boolean }> {
  const ssm = deps.ssm ?? createSsmClient(ctx);
  const ec2 = deps.ec2 ?? (await createEc2Client(ctx));
  const [ec2Rows, ssmRows] = await Promise.all([fetchEc2Instances(ec2), fetchSsmInstances(ssm)]);
  const merged = sortInstances(mergeInstances(ec2Rows, ssmRows), opts.recentIds);
  return { rows: opts.connectableOnly ? filterConnectable(merged) : merged, ssmUnavailable: ssmRows === 'unavailable' };
}
