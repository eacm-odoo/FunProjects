/**
 * Keeps URL loading on the public internet.
 *
 * The page asks the server to download a URL, and colleagues may reach the
 * server through a tunnel. Without this check anyone with the link could make
 * it fetch the router's admin page, another service on this PC or a cloud
 * metadata endpoint. Every address a host name resolves to is checked while
 * the connection is made, so the DNS answer cannot change between the check
 * and the request, and every redirect goes through the same check.
 */

import dns from "node:dns";
import net from "node:net";

const BLOCKED = new net.BlockList();
// Loopback, private networks, link-local, carrier NAT, documentation,
// benchmarking, multicast and reserved ranges.
for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) {
    BLOCKED.addSubnet(network, prefix, "ipv4");
}
// IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) are checked against the IPv4 rules by BlockList itself.
for (const [network, prefix] of [
    ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) {
    BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** Whether `address` (an IP literal) is on the public internet. */
export function isPublicAddress(address) {
    const family = net.isIP(address);
    if (!family) {
        return false;
    }
    return !BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

export class BlockedAddressError extends Error {
    constructor(message) {
        super(message);
        this.code = "ERR_BLOCKED_ADDRESS";
    }
}

/**
 * A `lookup` for http.request that refuses a host when any of its addresses
 * is not allowed. Node asks for every address (`all: true`) when it races
 * IPv4 and IPv6, and for one otherwise; both are answered.
 *
 * @param {(address: string) => boolean} [isAllowed] tests replace it to reach a local server
 */
export function guardedLookup(isAllowed = isPublicAddress) {
    return (hostname, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        const settings = typeof options === "number" ? { family: options } : options;
        dns.lookup(hostname, { ...settings, all: true }, (error, addresses) => {
            if (error) {
                callback(error);
                return;
            }
            const refused = addresses.find(({ address }) => !isAllowed(address));
            if (refused || !addresses.length) {
                callback(new BlockedAddressError(`${hostname} resolves to ${refused?.address ?? "nothing"}`));
                return;
            }
            if (settings.all) {
                callback(null, addresses);
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        });
    };
}
