import { describe, expect, test, vi } from 'vitest';
import {
  EC2_STATES,
  type Ec2Summary,
  fetchEc2Instances,
  fetchSsmInstances,
  filterConnectable,
  listInstances,
  mergeInstances,
  type SsmSummary,
  sortInstances,
} from '../../src/aws/instances.js';
import type { AwsContext, InstanceRow } from '../../src/types.js';

const ec2 = (over: Partial<Ec2Summary> = {}): Ec2Summary => ({
  instanceId: 'i-1',
  name: 'web',
  state: 'running',
  instanceType: 't4g.small',
  privateIp: '10.0.0.1',
  publicIp: null,
  ...over,
});
const ssm = (over: Partial<SsmSummary> = {}): SsmSummary => ({
  instanceId: 'i-1',
  pingStatus: 'Online',
  platformName: 'Amazon Linux',
  computerName: 'ip-10-0-0-1',
  ...over,
});
const row = (over: Partial<InstanceRow>): InstanceRow => ({
  instanceId: 'i-x',
  name: 'x',
  state: 'running',
  ssm: 'Online',
  instanceType: null,
  privateIp: null,
  publicIp: null,
  platform: null,
  connectable: true,
  reason: null,
  ...over,
});

describe('mergeInstances', () => {
  test('running + Online → connectable, reason null, ssm "Online"', () => {
    expect(mergeInstances([ec2()], [ssm()])).toEqual([
      {
        instanceId: 'i-1',
        name: 'web',
        state: 'running',
        ssm: 'Online',
        instanceType: 't4g.small',
        privateIp: '10.0.0.1',
        publicIp: null,
        platform: 'Amazon Linux',
        connectable: true,
        reason: null,
      },
    ]);
  });

  test('stopped → not connectable, reason "stopped"', () => {
    const [r] = mergeInstances([ec2({ state: 'stopped' })], [ssm({ pingStatus: 'ConnectionLost' })]);
    expect(r).toMatchObject({ connectable: false, reason: 'stopped', ssm: 'ConnectionLost' });
  });

  test('running without SSM record → ssm "None", reason "no SSM agent"', () => {
    const [r] = mergeInstances([ec2()], []);
    expect(r).toMatchObject({ connectable: false, ssm: 'None', reason: 'no SSM agent', platform: null });
  });

  test('ConnectionLost → "connection lost"; Inactive → "agent inactive"', () => {
    const [lost] = mergeInstances([ec2()], [ssm({ pingStatus: 'ConnectionLost' })]);
    const [inactive] = mergeInstances([ec2()], [ssm({ pingStatus: 'Inactive' })]);
    expect(lost).toMatchObject({ connectable: false, reason: 'connection lost' });
    expect(inactive).toMatchObject({ connectable: false, reason: 'agent inactive' });
  });

  test('SSM-only mi- node uses computerName, state "unknown", connectable when Online', () => {
    const rows = mergeInstances(
      [],
      [
        ssm({ instanceId: 'mi-1', computerName: 'onprem-1' }),
        ssm({ instanceId: 'mi-2', computerName: 'onprem-2', pingStatus: 'ConnectionLost' }),
      ],
    );
    expect(rows[0]).toEqual({
      instanceId: 'mi-1',
      name: 'onprem-1',
      state: 'unknown',
      ssm: 'Online',
      instanceType: null,
      privateIp: null,
      publicIp: null,
      platform: 'Amazon Linux',
      connectable: true,
      reason: null,
    });
    expect(rows[1]).toMatchObject({ instanceId: 'mi-2', connectable: false, reason: 'connection lost' });
  });

  test('ssm "unavailable" → ssm "unknown" and running rows connectable', () => {
    const rows = mergeInstances([ec2(), ec2({ instanceId: 'i-2', state: 'stopped' })], 'unavailable');
    expect(rows[0]).toMatchObject({ ssm: 'unknown', connectable: true, reason: null });
    expect(rows[1]).toMatchObject({ ssm: 'unknown', connectable: false, reason: 'stopped' });
  });
});

describe('sortInstances', () => {
  test('recent ids first in given order, then connectable by name, then the rest; null names last', () => {
    const rows = [
      row({ instanceId: 'i-a', name: 'alpha' }),
      row({ instanceId: 'i-b', name: 'beta' }),
      row({ instanceId: 'i-c', name: 'gamma', connectable: false, reason: 'stopped' }),
      row({ instanceId: 'i-d', name: null }),
      row({ instanceId: 'i-e', name: 'delta', connectable: false, reason: 'stopped' }),
      row({ instanceId: 'i-f', name: null, connectable: false, reason: 'stopped' }),
    ];
    expect(sortInstances(rows, ['i-c', 'i-b', 'i-missing']).map((r) => r.instanceId)).toEqual([
      'i-c',
      'i-b',
      'i-a',
      'i-d',
      'i-e',
      'i-f',
    ]);
  });

  test('same names are ordered by instance id', () => {
    const rows = [row({ instanceId: 'i-2', name: 'web' }), row({ instanceId: 'i-1', name: 'web' })];
    expect(sortInstances(rows, []).map((r) => r.instanceId)).toEqual(['i-1', 'i-2']);
  });
});

describe('filterConnectable', () => {
  test('keeps only connectable rows', () => {
    const rows = [row({ instanceId: 'i-1' }), row({ instanceId: 'i-2', connectable: false, reason: 'stopped' })];
    expect(filterConnectable(rows).map((r) => r.instanceId)).toEqual(['i-1']);
  });
});

describe('fetchEc2Instances', () => {
  const i1 = {
    InstanceId: 'i-1',
    State: { Name: 'running' },
    InstanceType: 't4g.small',
    PrivateIpAddress: '10.0.0.1',
    PublicIpAddress: '3.3.3.3',
    Tags: [{ Key: 'Name', Value: 'web' }],
  };
  const i2 = {
    InstanceId: 'i-2',
    State: { Name: 'stopped' },
    InstanceType: 't3.micro',
    Tags: [{ Key: 'Env', Value: 'x' }],
  };

  test('follows NextToken, sends the state filter and maps fields', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Reservations: [{ Instances: [i1] }], NextToken: 't' })
      .mockResolvedValueOnce({ Reservations: [{ Instances: [i2] }] });
    const rows = await fetchEc2Instances({ send });
    expect(rows).toEqual([
      {
        instanceId: 'i-1',
        name: 'web',
        state: 'running',
        instanceType: 't4g.small',
        privateIp: '10.0.0.1',
        publicIp: '3.3.3.3',
      },
      { instanceId: 'i-2', name: null, state: 'stopped', instanceType: 't3.micro', privateIp: null, publicIp: null },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Filters: [{ Name: 'instance-state-name', Values: EC2_STATES }],
      MaxResults: 1000,
    });
    expect(send.mock.calls[1]?.[0].input.NextToken).toBe('t');
  });
});

describe('fetchSsmInstances', () => {
  const info = {
    InstanceId: 'i-1',
    PingStatus: 'Online',
    PlatformName: 'Ubuntu',
    ComputerName: 'ip-10-0-1-159',
  };

  test('paginates with MaxResults 50 and maps fields', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ InstanceInformationList: [info], NextToken: 'n' })
      .mockResolvedValueOnce({
        InstanceInformationList: [{ ...info, InstanceId: 'i-2', PingStatus: 'ConnectionLost' }],
      });
    const rows = await fetchSsmInstances({ send });
    expect(rows).toEqual([
      { instanceId: 'i-1', pingStatus: 'Online', platformName: 'Ubuntu', computerName: 'ip-10-0-1-159' },
      { instanceId: 'i-2', pingStatus: 'ConnectionLost', platformName: 'Ubuntu', computerName: 'ip-10-0-1-159' },
    ]);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ MaxResults: 50 });
    expect(send.mock.calls[1]?.[0].input.NextToken).toBe('n');
  });

  test('returns "unavailable" on AccessDeniedException and rethrows other errors', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    expect(await fetchSsmInstances({ send: vi.fn().mockRejectedValue(denied) })).toBe('unavailable');
    const other = Object.assign(new Error('boom'), { name: 'ThrottlingException' });
    await expect(fetchSsmInstances({ send: vi.fn().mockRejectedValue(other) })).rejects.toBe(other);
  });
});

describe('listInstances', () => {
  const ctx: AwsContext = {
    profile: 'default',
    region: 'ap-northeast-2',
    credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
  };
  const ec2Client = {
    send: vi.fn().mockResolvedValue({
      Reservations: [
        {
          Instances: [
            { InstanceId: 'i-1', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'beta' }] },
            { InstanceId: 'i-2', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'alpha' }] },
            { InstanceId: 'i-3', State: { Name: 'stopped' }, Tags: [{ Key: 'Name', Value: 'gamma' }] },
          ],
        },
      ],
    }),
  };

  test('runs both fetches, merges, sorts, applies connectableOnly and reports ssmUnavailable', async () => {
    const ssmClient = { send: vi.fn().mockResolvedValue({ InstanceInformationList: [info('i-1'), info('i-2')] }) };
    const all = await listInstances(
      ctx,
      { recentIds: ['i-1'], connectableOnly: false },
      { ssm: ssmClient, ec2: ec2Client },
    );
    expect(all.ssmUnavailable).toBe(false);
    expect(all.rows.map((r) => r.instanceId)).toEqual(['i-1', 'i-2', 'i-3']);
    const only = await listInstances(ctx, { recentIds: [], connectableOnly: true }, { ssm: ssmClient, ec2: ec2Client });
    expect(only.rows.map((r) => r.instanceId)).toEqual(['i-2', 'i-1']);
  });

  test('reports ssmUnavailable when SSM access is denied', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
    const result = await listInstances(
      ctx,
      { recentIds: [], connectableOnly: false },
      { ssm: { send: vi.fn().mockRejectedValue(denied) }, ec2: ec2Client },
    );
    expect(result.ssmUnavailable).toBe(true);
    expect(result.rows.every((r) => r.ssm === 'unknown')).toBe(true);
  });

  function info(id: string) {
    return { InstanceId: id, PingStatus: 'Online', PlatformName: 'Linux', ComputerName: id };
  }
});
