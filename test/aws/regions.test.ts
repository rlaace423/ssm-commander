import { describe, expect, test, vi } from 'vitest';
import { listRegions, STATIC_REGIONS } from '../../src/aws/regions.js';

const credentials = async () => ({ accessKeyId: 'a', secretAccessKey: 'b' });

describe('listRegions', () => {
  test('returns sorted RegionName values from DescribeRegions (opted-in regions only)', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Regions: [{ RegionName: 'us-west-2' }, { RegionName: 'ap-northeast-2' }, {}] });
    expect(await listRegions(credentials, { ec2: { send } })).toEqual(['ap-northeast-2', 'us-west-2']);
    expect(send.mock.calls[0]?.[0].input).toEqual({ AllRegions: false });
  });

  test('falls back to STATIC_REGIONS on error or an empty answer', async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error('denied')) };
    expect(await listRegions(credentials, { ec2: failing })).toEqual(STATIC_REGIONS);
    const empty = { send: vi.fn().mockResolvedValue({ Regions: [] }) };
    expect(await listRegions(credentials, { ec2: empty })).toEqual(STATIC_REGIONS);
    expect(STATIC_REGIONS).toHaveLength(29);
    expect(STATIC_REGIONS).toContain('ap-northeast-2');
    expect([...STATIC_REGIONS].sort()).toEqual(STATIC_REGIONS);
  });
});
