import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Protects the server from being used to reach things it should not:
 * a crawler fetches whatever URL a user types, so without this check a user
 * could point it at localhost, the office network or a cloud metadata
 * service (SSRF). Hostnames are resolved and every resulting address must be
 * public. Switch it off with ALLOW_PRIVATE_ADDRESSES=true to crawl intranet
 * or local sites on purpose.
 */

const blockList = new net.BlockList();
const PRIVATE_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const PRIVATE_IPV6 = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
];
for (const [address, prefix] of PRIVATE_IPV4) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of PRIVATE_IPV6) blockList.addSubnet(address, prefix, 'ipv6');

export class AddressNotAllowedError extends Error {
  constructor(hostname, address) {
    super(`Refusing to fetch ${hostname}: it resolves to the private address ${address}`);
    this.name = 'AddressNotAllowedError';
    this.code = 'ADDRESS_NOT_ALLOWED';
  }
}

/** True for loopback, private, link-local, multicast and reserved addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 0) throw new TypeError(`Not an IP address: ${address}`);
  return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export class AddressGuard {
  #allowPrivateAddresses;
  #lookup;

  constructor({ allowPrivateAddresses = false, lookup = (hostname) => dns.lookup(hostname, { all: true }) } = {}) {
    this.#allowPrivateAddresses = allowPrivateAddresses;
    this.#lookup = lookup;
  }

  /** Resolves the hostname of `url` and throws AddressNotAllowedError if any address is private. */
  async assertAllowed(url) {
    if (this.#allowPrivateAddresses) return;

    const hostname = url.hostname.replace(/^\[|\]$/g, ''); // "[::1]" -> "::1"
    const addresses = net.isIP(hostname) ? [{ address: hostname }] : await this.#lookup(hostname);

    for (const { address } of addresses) {
      if (isPrivateAddress(address)) throw new AddressNotAllowedError(hostname, address);
    }
  }
}
