const { isIP } = require('node:net');
const os = require('node:os');

const TUNNEL_IFACE = /^(u?tun|tap|ppp|wg|ipsec|gif|stf|awdl|llw)\d*/i;

// Browsers mask host ICE addresses with mDNS names. Some LANs do not forward
// mDNS between wired/Wi-Fi clients. Add an address observed by our HTTP proxy
// as a second candidate; retain the browser's original candidate as well.
function observedAddressCandidate(candidate, address) {
  if (!candidate || typeof candidate.candidate !== 'string' || isIP(address) !== 4) return null;
  const firstOctet = Number(address.split('.')[0]);
  if (firstOctet === 0 || firstOctet === 127 || firstOctet >= 224) return null;
  const fields = candidate.candidate.trim().split(/\s+/);
  if (fields.length < 8 || fields[6] !== 'typ' || fields[7] !== 'host' ||
      !fields[4].toLowerCase().endsWith('.local')) return null;
  fields[4] = address;
  return { ...candidate, candidate: fields.join(' ') };
}

// Clients on the server machine reach the proxy via loopback; their usable LAN
// address is one of this machine's interfaces. Skip link-local, tunnel/VPN
// adapters (e.g. utun/tun/wg), and the 198.18.0.0/15 fake-IP range.
function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function localLanAddresses(preferredAddress, interfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (TUNNEL_IFACE.test(name)) continue;
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      const [a, b] = item.address.split('.').map(Number);
      if (a === 169 && b === 254) continue;
      if (a === 198 && (b === 18 || b === 19)) continue;
      if (!result.includes(item.address)) result.push(item.address);
    }
  }
  if (isIP(preferredAddress) === 4 && !isLoopback(preferredAddress)) {
    const prefix24 = preferredAddress.split('.').slice(0, 3).join('.') + '.';
    const same24 = result.filter(addr => addr.startsWith(prefix24));
    if (same24.length > 0) return same24;
  }
  return result;
}

module.exports = { observedAddressCandidate, isLoopback, localLanAddresses };
