import { describe, expect, it } from 'vite-plus/test';

import { route53Provider } from '../../lib/providers/route53.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { fetchInputUrl, getCall, stubRoutedFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

type RecordSetFixture = {
  name: string;
  type: string;
  ttl?: number;
  values: string[];
};

function rrsetList(recordSets: RecordSetFixture[]): Response {
  const sets = recordSets
    .map(
      (set) =>
        '<ResourceRecordSet>' +
        `<Name>${set.name}</Name><Type>${set.type}</Type>` +
        (set.ttl === undefined ? '' : `<TTL>${set.ttl}</TTL>`) +
        '<ResourceRecords>' +
        set.values
          .map((value) => `<ResourceRecord><Value>${value}</Value></ResourceRecord>`)
          .join('') +
        '</ResourceRecords></ResourceRecordSet>',
    )
    .join('');
  return textResponse(
    '<?xml version="1.0"?><ListResourceRecordSetsResponse>' +
      `<ResourceRecordSets>${sets}</ResourceRecordSets>` +
      '<IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>',
  );
}

function changeOk(): Response {
  return textResponse(
    '<?xml version="1.0"?><ChangeResourceRecordSetsResponse><ChangeInfo>' +
      '<Id>/change/C123</Id><Status>PENDING</Status>' +
      '</ChangeInfo></ChangeResourceRecordSetsResponse>',
  );
}

function awsError(code: string, message: string, status = 400): Response {
  return textResponse(
    '<?xml version="1.0"?><ErrorResponse><Error><Type>Sender</Type>' +
      `<Code>${code}</Code><Message>${message}</Message>` +
      '</Error><RequestId>req-1</RequestId></ErrorResponse>',
    status,
  );
}

function hostedZoneOk(name = 'example.com.'): Response {
  return textResponse(
    '<?xml version="1.0"?><GetHostedZoneResponse><HostedZone>' +
      `<Id>/hostedzone/Z123</Id><Name>${name}</Name>` +
      '</HostedZone></GetHostedZoneResponse>',
  );
}

function withHostedZone(
  routes: Parameters<typeof stubRoutedFetch>[0],
  zoneName = 'example.com.',
): Parameters<typeof stubRoutedFetch>[0] {
  return [
    {
      match: (url, method) =>
        method === 'GET' && /\/hostedzone\/[^/?]+$/.test(new URL(url).pathname),
      response: hostedZoneOk(zoneName),
    },
    ...routes,
  ];
}

function r53Config(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    route53: {
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI',
      hostedZoneId: 'Z123',
      ...overrides.route53,
    },
  });
}

describe('route53 provider', () => {
  it('requires credentials and a host before contacting the API', async () => {
    const fetchMock = stubRoutedFetch(withHostedZone([]));

    await expect(
      route53Provider.update(makeConfig({ route53: { accessKeyId: 'AKIA' } }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('ROUTE53_SECRET_ACCESS_KEY'),
      details: expect.objectContaining({ hasAccessKeyId: true, hasSecretAccessKey: false }),
    });

    await expect(
      route53Provider.update(r53Config({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast when no public IP is available', async () => {
    const fetchMock = stubRoutedFetch(withHostedZone([]));

    await expect(
      route53Provider.update(r53Config(), { v4: null, v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IP available',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upserts a changed A record with a SigV4-signed XML request', async () => {
    const fetchMock = stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/hostedzone/Z123/rrset?'),
          response: rrsetList([
            { name: 'home.example.com.', type: 'A', ttl: 300, values: ['1.1.1.1'] },
          ]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/hostedzone/Z123/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    const result = await route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        zoneId: 'Z123',
        recordName: 'home.example.com',
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              action: 'upsert',
              previous: '1.1.1.1',
              changeId: '/change/C123',
            }),
          }),
        ],
      }),
    });

    const list = getCall(fetchMock, 1);
    expect(list.url.host).toBe('route53.amazonaws.com');
    expect(list.url.searchParams.get('name')).toBe('home.example.com.');
    expect(list.url.searchParams.get('type')).toBe('A');
    expect(list.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(list.headers.get('Authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/route53\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    expect(post.headers.get('Content-Type')).toBe('application/xml');
    expect(post.body).toContain('<Action>UPSERT</Action>');
    expect(post.body).toContain('<Name>home.example.com.</Name>');
    expect(post.body).toContain('<Type>A</Type>');
    expect(post.body).toContain('<TTL>300</TTL>');
    expect(post.body).toContain('<Value>9.9.9.9</Value>');
    expect(post.headers.get('Authorization')).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('skips unchanged records but upserts on a TTL change', async () => {
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          // No trailing dot: names must be normalized before comparison.
          response: rrsetList([
            { name: 'home.example.com', type: 'A', ttl: 300, values: ['9.9.9.9'] },
          ]),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });

    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([
            { name: 'home.example.com.', type: 'A', ttl: 60, values: ['9.9.9.9'] },
          ]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
    });
  });

  it('treats the lexicographically-next record set as missing and creates when enabled', async () => {
    // Route53 list returns the *next* record set when there is no exact match.
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([
            { name: 'other.example.com.', type: 'A', ttl: 300, values: ['1.1.1.1'] },
          ]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'create' }) }),
        ],
      }),
    });
  });

  it('fails when the record is missing and createIfMissing is false', async () => {
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([]),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config({ route53: { createIfMissing: false } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('A record for home.example.com not found'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              hint: expect.stringMatching(/ROUTE53_CREATE_IF_MISSING/),
            }),
          }),
        ],
      }),
    });
  });

  it('updates A and AAAA independently and strips the /hostedzone/ prefix', async () => {
    const fetchMock = stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('type=A&'),
          response: rrsetList([
            { name: 'home.example.com.', type: 'A', ttl: 300, values: ['1.1.1.1'] },
          ]),
        },
        {
          match: (url, method) => method === 'GET' && url.includes('type=AAAA'),
          response: rrsetList([]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    const result = await route53Provider.update(
      r53Config({ route53: { hostedZoneId: '/hostedzone/Z123' } }),
      { v4: '9.9.9.9', v6: '2001:db8::9' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('A home.example.com -> 9.9.9.9');
    expect(result.message).toContain('Created AAAA home.example.com -> 2001:db8::9');

    for (const [input] of fetchMock.mock.calls) {
      const url = fetchInputUrl(input);
      expect(url).toContain('/hostedzone/Z123');
      expect(url).not.toContain('/hostedzone//hostedzone/');
    }
  });

  it('surfaces Route53 error responses from change requests', async () => {
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: awsError('InvalidChangeBatch', 'RRSet with DNS name x is not permitted'),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining(
        'RRSet with DNS name x is not permitted [InvalidChangeBatch]',
      ),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'create' }) }),
        ],
      }),
    });
  });

  it('falls back to HTTP status when the error body carries no message', async () => {
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: textResponse('<ErrorResponse></ErrorResponse>', 500),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Route53 API request failed (HTTP 500'),
    });

    // Message without a Code element is reported bare.
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: textResponse(
            '<ErrorResponse><Error><Message>Throttled</Message></Error></ErrorResponse>',
            400,
          ),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Throttled'),
    });
  });

  it('handles wildcard names, multi-value sets, and malformed record-set XML', async () => {
    // Wildcard host: `*` must be RFC3986-encoded in the signed query string.
    const fetchMock = stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config({ hosts: ['*.example.com'], hostname: '*.example.com' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A *.example.com -> 9.9.9.9'),
    });
    // `*` travels literally in the URL but is RFC3986-encoded when signing.
    expect(getCall(fetchMock, 1).url.searchParams.get('name')).toBe('*.example.com.');
    expect(getCall(fetchMock, 1).headers.get('Authorization')).toMatch(/Signature=[0-9a-f]{64}$/);

    // A record set with multiple values is never "unchanged"; it gets replaced.
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: rrsetList([
            { name: 'home.example.com.', type: 'A', ttl: 300, values: ['9.9.9.9', '8.8.8.8'] },
          ]),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({ previous: '9.9.9.9,8.8.8.8' }),
          }),
        ],
      }),
    });

    // Record-set XML without Name/Type is treated as missing.
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: textResponse(
            '<?xml version="1.0"?><ListResourceRecordSetsResponse><ResourceRecordSets>' +
              '<ResourceRecordSet><Weight>1</Weight></ResourceRecordSet>' +
              '</ResourceRecordSets></ListResourceRecordSetsResponse>',
          ),
        },
        {
          match: (url, method) => method === 'POST' && url.endsWith('/rrset/'),
          response: changeOk(),
        },
      ]),
    );

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com'),
    });
  });

  it('throws when the record lookup itself is rejected', async () => {
    stubRoutedFetch(
      withHostedZone([
        {
          match: (url, method) => method === 'GET' && url.includes('/rrset?'),
          response: awsError('SignatureDoesNotMatch', 'Signature expired', 403),
        },
      ]),
    );

    await expect(route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /record lookup for home\.example\.com\..*Signature expired \[SignatureDoesNotMatch\]/,
    );
  });

  it('refuses hosts that are not within the hosted zone apex', async () => {
    stubRoutedFetch(withHostedZone([], 'other.net.'));

    await expect(
      route53Provider.update(r53Config(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('not within Route53 zone other.net'),
    });
  });
});
