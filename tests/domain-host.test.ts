import { describe, expect, it } from 'vite-plus/test';

import { normalizeDnsName, splitDomainHost } from '../lib/providers/domain-host.js';

describe('normalizeDnsName', () => {
  it('lowercases and strips trailing dots', () => {
    expect(normalizeDnsName('Example.COM.')).toBe('example.com');
    expect(normalizeDnsName('home.example.com')).toBe('home.example.com');
  });
});

describe('splitDomainHost', () => {
  it('uses an explicit domain and maps apex to @', () => {
    expect(splitDomainHost('home.example.com', 'example.com')).toEqual({
      domain: 'example.com',
      name: 'home',
    });
    expect(splitDomainHost('example.com.', 'example.com')).toEqual({
      domain: 'example.com',
      name: '@',
    });
    expect(splitDomainHost('home', 'example.com')).toEqual({
      domain: 'example.com',
      name: 'home',
    });
    expect(splitDomainHost('other.net', 'example.com')).toBeNull();
  });

  it('derives the apex from the last two labels when domain is unset', () => {
    expect(splitDomainHost('home.example.com', null)).toEqual({
      domain: 'example.com',
      name: 'home',
    });
    expect(splitDomainHost('example.com', null)).toEqual({
      domain: 'example.com',
      name: '@',
    });
    expect(splitDomainHost('localhost', null)).toBeNull();
    expect(splitDomainHost('vpn.home.example.com', null)).toBeNull();
    expect(splitDomainHost('home.example.co.uk', null)).toBeNull();
    // Multi-part public suffixes must not derive "co.uk" as the apex.
    expect(splitDomainHost('example.co.uk', null)).toBeNull();
  });
});
