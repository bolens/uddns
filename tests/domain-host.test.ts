import { describe, expect, it } from 'vite-plus/test';

import { splitDomainHost } from '../lib/providers/domain-host.js';

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
  });
});
