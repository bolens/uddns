import { describe, expect, it } from 'vite-plus/test';

import { applyIpPolicy, parseIpFamily, parseIpMissing } from '../lib/ip-policy.js';

describe('ip policy', () => {
  it('keeps previous family on transient miss', () => {
    expect(
      applyIpPolicy(
        { v4: '203.0.113.10', v6: null },
        { v4: '198.51.100.1', v6: '2001:db8::1' },
        { family: 'dual', missing: 'keep' },
      ),
    ).toEqual({ v4: '203.0.113.10', v6: '2001:db8::1' });
  });

  it('clears missing family when configured', () => {
    expect(
      applyIpPolicy(
        { v4: '203.0.113.10', v6: null },
        { v4: '198.51.100.1', v6: '2001:db8::1' },
        { family: 'dual', missing: 'clear' },
      ),
    ).toEqual({ v4: '203.0.113.10', v6: null });
  });

  it('restricts to a single family', () => {
    expect(
      applyIpPolicy(
        { v4: '203.0.113.10', v6: '2001:db8::1' },
        { v4: null, v6: null },
        { family: 'v4', missing: 'clear' },
      ),
    ).toEqual({ v4: '203.0.113.10', v6: null });
  });

  it('parses family and missing policy', () => {
    expect(parseIpFamily('v6')).toBe('v6');
    expect(parseIpMissing('clear')).toBe('clear');
    expect(() => parseIpFamily('both')).toThrow(/UDDNS_IP_FAMILY/);
    expect(() => parseIpMissing('drop')).toThrow(/UDDNS_IP_MISSING/);
  });
});
