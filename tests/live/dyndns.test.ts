/**
 * Live checks against Dyn's official client-development test account.
 * @see https://help.dyn.com/test-account.html
 *
 * Dyn documents username/password `test`/`test` and shared hostnames such as
 * `test.dyndns.org`. Those credentials must never become application defaults.
 *
 * Other uDDNS providers (Cloudflare, DuckDNS, No-IP, Dynu, Namecheap DDNS) do
 * not publish a public DDNS sandbox, so their suites stay on mocked HTTP.
 */

import { describe, expect, it } from 'vite-plus/test';

import { HttpError } from '../../lib/providers/http.js';
import { dyndnsProvider } from '../../lib/providers/dyndns.js';
import { makeConfig } from '../helpers/config.js';

/** Dyn-published test credentials — not for production clients as defaults. */
const DYN_TEST_ACCOUNT = {
  updateUrl: 'https://members.dyndns.org/nic/update',
  username: 'test',
  password: 'test',
} as const;

/** Shared Dyn Dynamic DNS test hostnames (rotate if one is abuse-blocked). */
const DYN_TEST_HOSTS = [
  'test.dyndns.org',
  'test.ath.cx',
  'test.homeip.net',
  'test.dnsalias.net',
] as const;

/** RFC 5737 documentation address — safe to send; Dyn may still return dnserr. */
const DOC_IPV4 = '203.0.113.50';

const KNOWN_NIC_CODE =
  /^(good|nochg|badauth|notfqdn|nohost|numhost|abuse|badagent|!donator|911|dnserr)\b/i;

describe('dyndns live (Dyn official test account)', () => {
  it('round-trips members.dyndns.org and maps a real /nic/update response', async (ctx) => {
    const hostname = DYN_TEST_HOSTS[0]!;
    let result;

    try {
      result = await dyndnsProvider.update(
        makeConfig({
          dyndns: {
            ...DYN_TEST_ACCOUNT,
            hostname,
          },
        }),
        { v4: DOC_IPV4, v6: null },
      );
    } catch (error) {
      if (error instanceof HttpError) {
        ctx.skip();
        return;
      }
      throw error;
    }

    const response = result.details?.['response'];
    const responseText = typeof response === 'string' ? response : result.message;
    expect(responseText, `unexpected Dyn body: ${responseText}`).toMatch(KNOWN_NIC_CODE);

    const code = responseText.split(/\s+/)[0]?.toLowerCase() ?? '';

    if (code === 'good' || code === 'nochg') {
      expect(result.ok).toBe(true);
      if (code === 'nochg') {
        expect(result).toMatchObject({ skipped: true });
      }
      return;
    }

    // Dyn's shared test DNS backend often returns dnserr/911; still assert we
    // classified the wire response the same way the unit suite expects.
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({
      response: expect.stringMatching(KNOWN_NIC_CODE),
      hint: expect.any(String),
      hostname,
      url: expect.stringContaining('https://members.dyndns.org/nic/update'),
    });
  });
});
