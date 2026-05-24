import { describe, expect, it } from 'vitest';

import { parseEnabledChannelsFromMeta } from '@/lib/orchestration/admin/trigger-meta';

describe('parseEnabledChannelsFromMeta', () => {
  it('returns enabledChannels when the meta envelope is well-formed', () => {
    expect(parseEnabledChannelsFromMeta({ enabledChannels: ['twilio', 'whatsapp_cloud'] })).toEqual(
      ['twilio', 'whatsapp_cloud']
    );
  });

  it('returns [] when meta is null or undefined', () => {
    expect(parseEnabledChannelsFromMeta(null)).toEqual([]);
    expect(parseEnabledChannelsFromMeta(undefined)).toEqual([]);
  });

  it('returns [] when enabledChannels is missing', () => {
    expect(parseEnabledChannelsFromMeta({ other: 'value' })).toEqual([]);
  });

  it('returns [] when enabledChannels is the wrong shape', () => {
    expect(parseEnabledChannelsFromMeta({ enabledChannels: 'twilio' })).toEqual([]);
    expect(parseEnabledChannelsFromMeta({ enabledChannels: [1, 2, 3] })).toEqual([]);
    expect(parseEnabledChannelsFromMeta({ enabledChannels: [{ slug: 'twilio' }] })).toEqual([]);
  });

  it('returns [] when given a primitive', () => {
    expect(parseEnabledChannelsFromMeta('not-an-object')).toEqual([]);
    expect(parseEnabledChannelsFromMeta(42)).toEqual([]);
  });
});
