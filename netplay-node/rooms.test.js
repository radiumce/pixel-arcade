const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const io = require('../vendor/socket.io.min.js');

let server, url;
const clients = [];
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, done); reject(new Error(`Timeout: ${name}`)); }, 5000);
    function done(...args) { clearTimeout(timer); resolve(args); }
    socket.once(name, done);
  });
}
async function connect(namespace = '') {
  const socket = io(url + namespace, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await event(socket, 'connect');
  return socket;
}
function ack(socket, name, data) {
  return socket.timeout(5000).emitWithAck(name, data);
}
function extra(sessionid, userid) { return { sessionid, userid, player_name: userid, game_id: 1 }; }
async function streamRoom(code, maxPlayers = 2) {
  const host = await connect();
  assert.equal(await ack(host, 'open-room', { extra: extra(code, 'host'), maxPlayers, password: 'secret' }), null);
  return host;
}
async function streamJoin(socket, code, id = 'guest', password = 'secret') {
  return ack(socket, 'join-room', { extra: extra(code, id), password });
}
before(async () => {
  server = spawn(process.execPath, [require.resolve('./server')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Signaling server did not start')), 5000);
    server.once('error', reject);
    server.stdout.on('data', data => {
      const match = String(data).match(/Server running on port (\d+)/);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    });
    server.stderr.on('data', data => process.stderr.write(data));
  });
});
after(async () => {
  clients.forEach(socket => socket.disconnect());
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
});

test('stream replaces a live P2, including reused IDs, without removing P1 or the new P2', async () => {
  const host = await streamRoom('stream-replace');
  let previous = await connect();
  assert.equal(await streamJoin(previous, 'stream-replace'), null);
  for (let i = 0; i < 4; i++) {
    const next = await connect();
    const replaced = event(previous, 'room-replaced');
    const disconnected = event(previous, 'disconnect');
    const updated = event(host, 'users-updated');
    assert.equal(await streamJoin(next, 'stream-replace'), null);
    await replaced;
    assert.equal((await disconnected)[0], 'io server disconnect');
    const [players] = await updated;
    assert.equal(players.host.socketId, host.id);
    assert.equal(players.guest.socketId, next.id);
    assert.equal(Object.keys(players).length, 2);
    assert.equal(previous.active, false, 'server kick must not auto-reconnect');
    assert.equal(host.connected, true);
    // Repeat join is idempotent; old leave/disconnect cannot delete the new membership.
    assert.equal(await streamJoin(next, 'stream-replace'), null);
    const relayed = event(host, 'webrtc-signal');
    next.emit('webrtc-signal', { target: host.id, offer: { type: 'offer', sdp: 'new guest' } });
    assert.equal((await relayed)[0].sender, next.id);
    previous = next;
  }
});

test('stream validates password and protects P1 before replacing anyone', async () => {
  const host = await streamRoom('stream-validation');
  const guest = await connect(), invalid = await connect();
  assert.equal(await streamJoin(guest, 'stream-validation'), null);
  assert.equal(await streamJoin(invalid, 'stream-validation', 'new', 'wrong'), 'Incorrect password');
  assert.equal(await streamJoin(invalid, 'stream-validation', 'host'), 'Cannot replace room owner');
  assert.equal(await streamJoin(host, 'stream-validation', 'new'), 'Cannot replace room owner');
  assert.equal(guest.connected, true);
  assert.equal(host.connected, true);
});

test('rooms with more than two players retain their capacity behavior', async () => {
  await streamRoom('multiplayer', 3);
  const a = await connect(), b = await connect(), c = await connect();
  assert.equal(await streamJoin(a, 'multiplayer', 'a'), null);
  assert.equal(await streamJoin(b, 'multiplayer', 'b'), null);
  assert.equal(await streamJoin(c, 'multiplayer', 'c'), 'Room full');
  assert.equal(a.connected && b.connected, true);
});

test('retired sync signaling namespace is unavailable', async () => {
  const socket = io(url + '/sync', { transports: ['websocket'], forceNew: true,
    autoConnect: false, reconnection: false });
  clients.push(socket);
  const rejected = event(socket, 'connect_error');
  socket.connect();
  assert.match((await rejected)[0].message, /Invalid namespace/);
});
