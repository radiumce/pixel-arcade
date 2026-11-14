const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { observedAddressCandidate, isLoopback, localLanAddresses } = require('./lan-ice');

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3000;
let rooms = {};

function removeSocketFromRoom(socket) {
  const sessionId = socket.sessionId;
  const playerId = socket.playerId;
  if (!sessionId || !playerId) return null;
  const room = rooms[sessionId];
  if (room) {
    if (room.players[playerId]?.socketId === socket.id) {
      delete room.players[playerId];
    }
    io.to(sessionId).emit('users-updated', room.players);
    const remainingPlayers = Object.keys(room.players);
    if (remainingPlayers.length === 0) {
      delete rooms[sessionId];
    } else if (socket.id === room.owner) {
      room.owner = room.players[remainingPlayers[0]].socketId;
      io.to(sessionId).emit('users-updated', room.players);
    }
  }
  return sessionId;
}

setInterval(() => {
  for (const sessionId in rooms) {
    if (Object.keys(rooms[sessionId].players).length === 0) {
      delete rooms[sessionId];
    }
  }
}, 60000);

app.get('/list', (req, res) => {
  const gameId = req.query.game_id;
  const openRooms = Object.keys(rooms)
    .filter((sessionId) => {
      const room = rooms[sessionId];
      return (
        room &&
        Object.keys(room.players).length < room.maxPlayers &&
        String(room.gameId) === gameId
      );
    })
    .reduce((acc, sessionId) => {
      const room = rooms[sessionId];
      const ownerPlayerId = Object.keys(room.players).find(
        (playerId) => room.players[playerId].socketId === room.owner
      );
      const playerName = ownerPlayerId ? room.players[ownerPlayerId].player_name : 'Unknown';
      acc[sessionId] = {
        room_name: room.roomName,
        current: Object.keys(room.players).length,
        max: room.maxPlayers,
        player_name: playerName,
        hasPassword: !!room.password,
      };
      return acc;
    }, {});
  res.json(openRooms);
});

io.on('connection', (socket) => {
  // Enable explicitly for LAN troubleshooting; metrics never go to other peers.
  socket.on('stream-diagnostics', (data) => {
    if (process.env.STREAM_DIAGNOSTICS !== '1' || !socket.sessionId) return;
    if (!data || !['host', 'guest'].includes(data.role) || !Array.isArray(data.peers)) return;
    const record = JSON.stringify({
      time: Date.now(), socketId: socket.id, room: data.room, role: data.role,
      peers: data.peers.slice(0, 3), video: data.video, pixel: data.pixel,
    });
    if (record.length <= 6000) console.log('[stream-diag] ' + record);
  });

  socket.on('open-room', (data, callback) => {
    let sessionId, playerId, roomName, gameId, maxPlayers;
    if (data.extra) {
      sessionId = data.extra.sessionid;
      playerId = data.extra.userid || data.extra.playerId;
      roomName = data.extra.room_name;
      gameId = data.extra.game_id;
      maxPlayers = data.maxPlayers || 4;
    }
    if (!sessionId || !playerId) {
      return callback('Invalid data: sessionId and playerId required');
    }
    if (rooms[sessionId]) {
      return callback('Room already exists');
    }

    let finalDomain = data.extra.domain;
    if (finalDomain === undefined || finalDomain === null) {
        finalDomain = 'unknown';
    }

    rooms[sessionId] = {
      owner: socket.id,
      players: { [playerId]: { ...data.extra, socketId: socket.id } },
      roomName: roomName || `Room ${sessionId}`,
      gameId: gameId || 'default',
      domain: finalDomain,
      password: data.password || null,
      maxPlayers: maxPlayers,
    };
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.playerId = playerId;
    io.to(sessionId).emit('users-updated', rooms[sessionId].players);
    callback(null);
  });

  socket.on('join-room', (data, callback) => {
    const { sessionid: sessionId, userid: playerId } = data.extra || {};
    
    if (!sessionId || !playerId) {
        if (typeof callback === 'function') callback('Invalid data: sessionId and playerId required');
        return;
    }

    const room = rooms[sessionId];
    if (!room) {
        if (typeof callback === 'function') callback('Room not found');
        return;
    }

    const roomPassword = data.password || null;
    if (room.password && room.password !== roomPassword) {
        if (typeof callback === 'function') callback('Incorrect password');
        return;
    }
    
    const existingPlayer = room.players[playerId];
    if (socket.id === room.owner || (existingPlayer && existingPlayer.socketId === room.owner)) {
        if (typeof callback === 'function') callback('Cannot replace room owner');
        return;
    }
    if (existingPlayer && existingPlayer.socketId === socket.id) {
        if (typeof callback === 'function') callback(null, room.players);
        return;
    }

    // Two-player arcade rooms always give the P2 slot to the latest join.
    // Detach old membership before disconnecting so late cleanup cannot remove P2.
    if (room.maxPlayers === 2) {
      for (const [id, player] of Object.entries(room.players)) {
        if (player.socketId === room.owner) continue;
        const previous = io.sockets.sockets.get(player.socketId);
        delete room.players[id];
        if (previous) {
          previous.leave(sessionId);
          delete previous.sessionId;
          delete previous.playerId;
          previous.emit('room-replaced');
          previous.disconnect();
        }
      }
    }

    if (Object.keys(room.players).length >= room.maxPlayers) {
        if (typeof callback === 'function') callback('Room full');
        return;
    }
    
    room.players[playerId] = { ...data.extra, socketId: socket.id };
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.playerId = playerId;
    
    io.to(sessionId).emit('users-updated', room.players);
    
    if (typeof callback === 'function') {
        callback(null, room.players);
    }
  });

  socket.on('leave-room', () => {
    const sessionId = removeSocketFromRoom(socket);
    if (sessionId) {
      socket.leave(sessionId);
      delete socket.sessionId;
      delete socket.playerId;
    }
  });

  socket.on('webrtc-signal', (data) => {
    try {
        const { target, candidate, offer, answer, requestRenegotiate } = data || {};

        if (!target && !requestRenegotiate) {
            throw new Error('Target ID missing unless requesting renegotiation');
        }

        const payload = requestRenegotiate
          ? { sender: socket.id, requestRenegotiate: true }
          : { sender: socket.id, candidate, offer, answer };

        const targetSocket = target ? io.sockets.sockets.get(target) : null;
        // Ignore late offers/ICE from a replaced guest, including packets already queued.
        const room = rooms[socket.sessionId];
        if (!room || room.players[socket.playerId]?.socketId !== socket.id ||
            !targetSocket || targetSocket.sessionId !== socket.sessionId ||
            room.players[targetSocket.playerId]?.socketId !== targetSocket.id) return;
        targetSocket.emit('webrtc-signal', payload);
        if (process.env.LAN_NETPLAY === '1' && candidate && socket.sessionId &&
            socket.sessionId === targetSocket.sessionId &&
            ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.handshake.address)) {
          const observed = socket.handshake.headers['x-arcade-client-ip'];
          const targetObserved = targetSocket.handshake.headers['x-arcade-client-ip'];
          const addresses = isLoopback(observed) ? localLanAddresses(targetObserved) : [observed];
          for (const address of addresses) {
            const supplemental = observedAddressCandidate(candidate, address);
            if (supplemental) {
              targetSocket.emit('webrtc-signal', { sender: socket.id, candidate: supplemental });
              console.log(`[lan-ice] ${socket.id} -> ${target}: added observed host ${address}`);
            }
          }
        }
        if (offer || answer || candidate || requestRenegotiate) {
          console.log(`[webrtc-signal] ${socket.id} -> ${target} offer=${!!offer} answer=${!!answer} cand=${!!candidate} reneg=${!!requestRenegotiate} direct=${!!targetSocket}`);
          if (candidate && process.env.STREAM_DIAGNOSTICS === '1') {
            const fields = String(candidate.candidate || '').split(/\s+/);
            console.log('[ice-candidate] ' + JSON.stringify({
              socketId: socket.id, address: fields[4], port: fields[5], type: fields[7],
              protocol: fields[2], observed: socket.handshake.headers['x-arcade-client-ip'],
            }));
          }
        }
    } catch (error) {
        console.error(`WebRTC signal error: ${error.message}`);
    }
  });

  socket.on('data-message', (data) => {
    if (socket.sessionId) {
      socket.to(socket.sessionId).emit('data-message', data);
    }
  });

  socket.on('disconnect', () => {
    removeSocketFromRoom(socket);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Server running on port ${server.address().port}`));
