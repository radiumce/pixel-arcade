const test = require('node:test');
const assert = require('node:assert/strict');
const { observedAddressCandidate, localLanAddresses } = require('./lan-ice');

const candidate = {
  candidate: 'candidate:123 1 udp 2113937151 peer.local 54321 typ host generation 0 ufrag abc',
  sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc',
};

test('adds observed IPv4 without changing the port, media or original candidate', () => {
  const result = observedAddressCandidate(candidate, '172.10.0.9');
  assert.equal(result.candidate, 'candidate:123 1 udp 2113937151 172.10.0.9 54321 typ host generation 0 ufrag abc');
  assert.equal(result.sdpMid, candidate.sdpMid);
  assert.equal(result.sdpMLineIndex, 0);
  assert.equal(result.usernameFragment, 'abc');
  assert.ok(candidate.candidate.includes('peer.local'));
});

test('does not change STUN, TURN or already numeric host candidates', () => {
  for (const line of [candidate.candidate.replace('typ host', 'typ srflx'),
    candidate.candidate.replace('typ host', 'typ relay'),
    candidate.candidate.replace('peer.local', '192.168.1.2')]) {
    assert.equal(observedAddressCandidate({ ...candidate, candidate: line }, '172.10.0.9'), null);
  }
});

test('rejects invalid, loopback and unusable observed addresses', () => {
  for (const address of ['not-an-ip', undefined, '127.0.0.1', '0.0.0.0', '224.0.0.1', '::1']) {
    assert.equal(observedAddressCandidate(candidate, address), null);
  }
  assert.equal(observedAddressCandidate(null, '172.10.0.9'), null);
});

test('localLanAddresses excludes VPN/tunnel interfaces and prefers peer /24 subnet', () => {
  const fakeIfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.0.109', internal: false }],
    en5: [{ family: 'IPv4', address: '10.0.1.25', internal: false }],
    utun4: [{ family: 'IPv4', address: '10.80.12.3', internal: false }],
    utun8: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    awdl0: [{ family: 'IPv4', address: '169.254.10.20', internal: false }],
  };
  assert.deepEqual(localLanAddresses(undefined, fakeIfaces), ['192.168.0.109', '10.0.1.25']);
  assert.deepEqual(localLanAddresses('192.168.0.119', fakeIfaces), ['192.168.0.109']);
});
