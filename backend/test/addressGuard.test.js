import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AddressGuard, AddressNotAllowedError, isPrivateAddress } from '../src/crawler/fetchers/addressGuard.js';

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.5', '172.31.255.255', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.ok(isPrivateAddress(ip), ip);
    }
  });

  it('accepts public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('rejects things that are not IP addresses', () => {
    assert.throws(() => isPrivateAddress('example.com'), TypeError);
  });
});

describe('AddressGuard', () => {
  const lookup = async (hostname) => {
    const table = {
      'public.example': [{ address: '93.184.216.34', family: 4 }],
      'dual.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      localhost: [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }],
    };
    if (!table[hostname]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return table[hostname];
  };

  it('allows public hostnames and literal public IPs', async () => {
    const guard = new AddressGuard({ lookup });
    await guard.assertAllowed(new URL('https://public.example/'));
    await guard.assertAllowed(new URL('http://93.184.216.34/'));
  });

  it('refuses hostnames with any private address, literal private IPs and bracketed IPv6', async () => {
    const guard = new AddressGuard({ lookup });
    await assert.rejects(guard.assertAllowed(new URL('http://localhost:3000/')), AddressNotAllowedError);
    await assert.rejects(guard.assertAllowed(new URL('https://dual.example/')), AddressNotAllowedError);
    await assert.rejects(guard.assertAllowed(new URL('http://192.168.1.1/')), AddressNotAllowedError);
    await assert.rejects(guard.assertAllowed(new URL('http://[::1]/')), AddressNotAllowedError);
  });

  it('passes DNS failures through', async () => {
    const guard = new AddressGuard({ lookup });
    await assert.rejects(guard.assertAllowed(new URL('https://missing.example/')), { code: 'ENOTFOUND' });
  });

  it('can be switched off for intranet crawling', async () => {
    const guard = new AddressGuard({ lookup, allowPrivateAddresses: true });
    await guard.assertAllowed(new URL('http://localhost/'));
  });
});
