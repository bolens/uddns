import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { dyndnsProvider } from '../../lib/providers/dyndns.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dyndns provider', () => {
  it('calls a custom /nic/update endpoint with credentials', async () => {
    const fetchMock = stubFetch(async () => textResponse('good 198.51.100.2'));

    const result = await dyndnsProvider.update(
      makeConfig({
        dyndns: {
          updateUrl: 'https://ddns.example.test/nic/update',
          username: 'dyn-user',
          password: 'dyn-pass',
          hostname: 'home.example.com',
        },
      }),
      { v4: '198.51.100.2', v6: null },
    );

    expect(result).toMatchObject({ ok: true, message: 'good 198.51.100.2' });

    const call = getCall(fetchMock);
    expect(call.url.toString()).toBe(
      'https://ddns.example.test/nic/update?hostname=home.example.com&myip=198.51.100.2',
    );
    expect(call.auth).toEqual({ user: 'dyn-user', pass: 'dyn-pass' });
  });

  it('treats nochg as skipped and surfaces abuse/badauth failures', async () => {
    stubFetch(async () => textResponse('nochg 198.51.100.2'));
    await expect(
      dyndnsProvider.update(
        makeConfig({
          dyndns: {
            updateUrl: 'https://ddns.example.test/nic/update',
            username: 'dyn-user',
            password: 'dyn-pass',
            hostname: 'home.example.com',
          },
        }),
        { v4: '198.51.100.2', v6: null },
      ),
    ).resolves.toMatchObject({ ok: true, skipped: true });

    stubFetch(async () => textResponse('abuse'));
    await expect(
      dyndnsProvider.update(
        makeConfig({
          dyndns: {
            updateUrl: 'https://ddns.example.test/nic/update',
            username: 'dyn-user',
            password: 'dyn-pass',
            hostname: 'home.example.com',
          },
        }),
        { v4: '198.51.100.2', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('abuse'),
      details: expect.objectContaining({
        hint: expect.stringMatching(/abuse|frequent/i),
      }),
    });
  });

  it('requires username/password/hostname before calling the network', async () => {
    const fetchMock = stubFetch(async () => textResponse('good 1.1.1.1'));

    const result = await dyndnsProvider.update(
      makeConfig({
        dyndns: {
          updateUrl: 'https://user:hunter2@ddns.example.test/nic/update',
          username: null,
          password: 'pass',
          hostname: 'home.example.com',
        },
      }),
      { v4: '1.1.1.1', v6: null },
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // Credentials embedded in the configured URL never reach log details.
    expect(result.details?.['updateUrl']).toBe('https://***:***@ddns.example.test/nic/update');
    expect(JSON.stringify(result.details)).not.toContain('hunter2');
  });
});
