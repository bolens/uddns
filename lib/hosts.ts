import type { AppConfig, NamecheapConfig } from './schemas/provider.js';

export type HostSources = {
  hosts?: string | null;
  host?: string | null;
  cloudflareRecordName?: string | null;
  duckdnsDomains?: string | null;
  namecheapHost?: string | null;
  namecheapDomain?: string | null;
};

/**
 * Split a host list string into unique, trimmed hostnames.
 * Accepts commas and/or whitespace: `a.example.com, b.example.com`.
 */
export function parseHostList(value: string | null | undefined): string[] {
  if (value == null || value.trim() === '') {
    return [];
  }

  const seen = new Set<string>();
  const hosts: string[] = [];

  for (const part of value.split(/[,\s]+/)) {
    const host = part.trim().toLowerCase();
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    hosts.push(host);
  }

  return hosts;
}

/**
 * Resolve the effective host list from config sources.
 *
 * Precedence:
 * 1. `UDDNS_HOSTS`
 * 2. singular host fields (`UDDNS_HOST`, Cloudflare record name, DuckDNS domains, …)
 */
export function resolveHosts(sources: HostSources): string[] {
  const fromList = parseHostList(sources.hosts);
  if (fromList.length > 0) {
    return fromList;
  }

  const singular = [
    sources.host,
    sources.cloudflareRecordName,
    ...parseHostList(sources.duckdnsDomains),
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');

  if (singular.length > 0) {
    return parseHostList(singular.join(','));
  }

  if (sources.namecheapDomain) {
    const label = sources.namecheapHost?.trim() || '@';
    if (label === '@') {
      return [sources.namecheapDomain.toLowerCase()];
    }
    return [`${label}.${sources.namecheapDomain}`.toLowerCase()];
  }

  return [];
}

/**
 * Bind a single host into the provider-facing config fields.
 */
export function configForHost(config: AppConfig, host: string): AppConfig {
  const multiHost = config.hosts.length > 1;

  return {
    ...config,
    hostname: host,
    cloudflare: {
      ...config.cloudflare,
      recordName: host,
      recordId: multiHost ? null : config.cloudflare.recordId,
    },
    duckdns: {
      ...config.duckdns,
      domains: stripDuckDnsSuffix(host),
    },
    namecheap: bindNamecheapHost(config.namecheap, host),
    dyndns: {
      ...config.dyndns,
      hostname: host,
    },
  };
}

/** Strip a trailing `.duckdns.org` suffix (DuckDNS update API wants the subdomain only). */
export function stripDuckDnsSuffix(host: string): string {
  return host.replace(/\.duckdns\.org$/i, '');
}

/**
 * Map an FQDN or subdomain onto Namecheap's host + domain fields.
 */
export function bindNamecheapHost(namecheap: NamecheapConfig, host: string): NamecheapConfig {
  if (namecheap.domain) {
    const domain = namecheap.domain.toLowerCase();
    const suffix = `.${domain}`;
    const normalized = host.toLowerCase();

    if (normalized === domain) {
      return { ...namecheap, host: '@', domain };
    }

    if (normalized.endsWith(suffix)) {
      const sub = normalized.slice(0, -suffix.length) || '@';
      return { ...namecheap, host: sub, domain };
    }

    return { ...namecheap, host: normalized, domain };
  }

  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length >= 2) {
    return {
      ...namecheap,
      host: parts[0] ?? '@',
      domain: parts.slice(1).join('.'),
    };
  }

  return { ...namecheap, host: host || '@' };
}
