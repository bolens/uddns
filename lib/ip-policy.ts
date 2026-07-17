/**
 * Normalize discovered public IPs according to family and missing-family policy.
 */

import type { PublicIP } from './schemas/provider.js';

export type IpFamily = 'dual' | 'v4' | 'v6';
export type IpMissingPolicy = 'keep' | 'clear';

export type IpPolicy = {
  family: IpFamily;
  missing: IpMissingPolicy;
};

export function applyIpPolicy(
  discovered: PublicIP,
  previous: PublicIP,
  policy: IpPolicy,
): PublicIP {
  let v4 = discovered.v4;
  let v6 = discovered.v6;

  if (policy.family === 'v4') {
    v6 = null;
  } else if (policy.family === 'v6') {
    v4 = null;
  }

  if (policy.missing === 'keep') {
    if (policy.family !== 'v6' && v4 == null && previous.v4 != null) {
      v4 = previous.v4;
    }
    if (policy.family !== 'v4' && v6 == null && previous.v6 != null) {
      v6 = previous.v6;
    }
  }

  return { v4, v6 };
}

export function parseIpFamily(value: string | undefined): IpFamily {
  const normalized = (value ?? 'dual').toLowerCase();
  if (normalized === 'dual' || normalized === 'v4' || normalized === 'v6') {
    return normalized;
  }
  throw new Error('UDDNS_IP_FAMILY must be one of: dual, v4, v6');
}

export function parseIpMissing(value: string | undefined): IpMissingPolicy {
  const normalized = (value ?? 'keep').toLowerCase();
  if (normalized === 'keep' || normalized === 'clear') {
    return normalized;
  }
  throw new Error('UDDNS_IP_MISSING must be one of: keep, clear');
}
