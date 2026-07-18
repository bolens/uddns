import { describe, expect, it } from 'vite-plus/test';

import { loadHealthConfig } from '../lib/health-config.js';

describe('loadHealthConfig', () => {
  it('defaults to disabled health server', () => {
    expect(loadHealthConfig({})).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3924,
      metricsEnabled: false,
      authToken: null,
      tlsCert: null,
      tlsKey: null,
    });
  });

  it('parses enabled health and metrics on loopback without a token', () => {
    expect(
      loadHealthConfig({
        UDDNS_HEALTH: '1',
        UDDNS_HEALTH_HOST: '127.0.0.1',
        UDDNS_HEALTH_PORT: '4000',
        UDDNS_METRICS: 'true',
      }),
    ).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 4000,
      metricsEnabled: true,
      authToken: null,
      tlsCert: null,
      tlsKey: null,
    });
  });

  it('requires auth token and TLS when binding off loopback', () => {
    expect(() =>
      loadHealthConfig({
        UDDNS_HEALTH: '1',
        UDDNS_HEALTH_HOST: '0.0.0.0',
      }),
    ).toThrow(/UDDNS_HEALTH_AUTH_TOKEN/);

    expect(() =>
      loadHealthConfig({
        UDDNS_HEALTH: '1',
        UDDNS_HEALTH_HOST: '0.0.0.0',
        UDDNS_HEALTH_AUTH_TOKEN: 'health-secret',
      }),
    ).toThrow(/UDDNS_HEALTH_TLS_CERT/);

    expect(
      loadHealthConfig({
        UDDNS_HEALTH: '1',
        UDDNS_HEALTH_HOST: '0.0.0.0',
        UDDNS_HEALTH_PORT: '4000',
        UDDNS_METRICS: 'true',
        UDDNS_HEALTH_AUTH_TOKEN: 'health-secret',
        UDDNS_HEALTH_TLS_CERT: '/tmp/cert.pem',
        UDDNS_HEALTH_TLS_KEY: '/tmp/key.pem',
      }),
    ).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 4000,
      metricsEnabled: true,
      authToken: 'health-secret',
      tlsCert: '/tmp/cert.pem',
      tlsKey: '/tmp/key.pem',
    });
  });

  it('rejects invalid port and boolean values', () => {
    expect(() => loadHealthConfig({ UDDNS_HEALTH_PORT: '-1' })).toThrow(/UDDNS_HEALTH_PORT/);
    expect(() => loadHealthConfig({ UDDNS_HEALTH: 'maybe' })).toThrow(/UDDNS_HEALTH/);
  });
});
