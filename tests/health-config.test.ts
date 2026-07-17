import { describe, expect, it } from 'vite-plus/test';

import { loadHealthConfig } from '../lib/health-config.js';

describe('loadHealthConfig', () => {
  it('defaults to disabled health server', () => {
    expect(loadHealthConfig({})).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3924,
      metricsEnabled: false,
    });
  });

  it('parses enabled health and metrics', () => {
    expect(
      loadHealthConfig({
        UDDNS_HEALTH: '1',
        UDDNS_HEALTH_HOST: '0.0.0.0',
        UDDNS_HEALTH_PORT: '4000',
        UDDNS_METRICS: 'true',
      }),
    ).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 4000,
      metricsEnabled: true,
    });
  });

  it('rejects invalid port and boolean values', () => {
    expect(() => loadHealthConfig({ UDDNS_HEALTH_PORT: '-1' })).toThrow(/UDDNS_HEALTH_PORT/);
    expect(() => loadHealthConfig({ UDDNS_HEALTH: 'maybe' })).toThrow(/UDDNS_HEALTH/);
  });
});
