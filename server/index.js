const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { COUNTDOWN_SEC } = require('./config');
const { generateRoomCode, joinQueue, leaveQueue } = require('./matchmaking');
const { GameRoom } = require('./gameState');
const { listMaps, resolveMap } = require('./maps');
const gameLoop = require('./gameLoop');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client')));

// roomCode -> { players, host, mapId }
// `mapId === null` means "random — server picks at game start".
const lobbies = {};
const socketToRoom = {}; // socketId -> roomCode
const existingCodes = new Set();
// roomCode -> { host, mapId } — kept while a game is running so we can
// rebuild the lobby with the same host/map when the round ends.
const roomMeta = {};

gameLoop.init(io, onRoomEnd);

const AVAILABLE_MAPS = listMaps();

function getLobby(code) { return lobbies[code]; }

function broadcastLobbyState(code) {
  const lobby = getLobby(code);
  if (!lobby) return;
  io.to(code).emit('lobby:state', {
    roomCode: code,
    players: lobby.players,
    host: lobby.host,
    mapId: lobby.mapId,
    availableMaps: AVAILABLE_MAPS,
  });
}

function startGame(code) {
  const lobby = getLobby(code);
  if (!lobby) return;

  // Resolve the map now (random pick happens here if mapId is null/missing).
  const map = resolveMap(lobby.mapId);
  const hostId = lobby.host;
  const requestedMapId = lobby.mapId;

  let countdown = COUNTDOWN_SEC;
  io.to(code).emit('game:countdown', { countdown });
  const timer = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      io.to(code).emit('game:countdown', { countdown });
    } else {
      clearInterval(timer);
      const room = new GameRoom(code, lobby.players, map);
      gameLoop.addRoom(room);
      roomMeta[code] = { host: hostId, mapId: requestedMapId };
      io.to(code).emit('game:start', {
        teamAssignments: lobby.players.map(p => ({ id: p.id, team: p.team })),
        map: {
          id: map.id,
          name: map.name,
          width: map.width,
          height: map.height,
          obstacles: map.obstacles,
          stream: map.stream,
          bases: map.bases,
        },
      });
      delete lobbies[code];
    }
  }, 1000);
}

// Called by gameLoop when a GameRoom enters phase 'ended'. We rebuild the
// lobby for that code with the surviving players (so they can play again),
// then evict every socket from the io room — clients have to explicitly emit
// `lobby:rejoin` to opt back in, so end-screen broadcasts don't yank everyone
// straight back to the lobby screen.
function onRoomEnd(code, room) {
  const meta = roomMeta[code];
  delete roomMeta[code];

  const survivors = Object.values(room.players)
    .filter(p => !p.disconnected)
    .map(p => ({ id: p.id, name: p.name, team: p.team, ready: false }));

  if (survivors.length > 0) {
    const hostStillHere = meta && survivors.some(p => p.id === meta.host);
    lobbies[code] = {
      players: survivors,
      host: hostStillHere ? meta.host : survivors[0].id,
      mapId: meta ? meta.mapId : null,
    };
  } else {
    existingCodes.delete(code);
  }

  const sids = io.sockets.adapter.rooms.get(code);
  if (sids) {
    for (const sid of [...sids]) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(code);
    }
  }
}

io.on('connection', (socket) => {
  socket.on('lobby:create', ({ playerName }) => {
    try {
      const code = generateRoomCode(existingCodes);
      existingCodes.add(code);
      lobbies[code] = {
        players: [{ id: socket.id, name: playerName, team: 'A', ready: false }],
        host: socket.id,
        mapId: null, // null = random
      };
      socketToRoom[socket.id] = code;
      socket.join(code);
      broadcastLobbyState(code);
    } catch (e) {
      socket.emit('error', { code: 'ROOM_ERROR', message: e.message });
    }
  });

  socket.on('lobby:join', ({ roomCode, playerName }) => {
    const lobby = getLobby(roomCode);
    if (!lobby) { socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }); return; }
    if (lobby.players.length >= 8) { socket.emit('error', { code: 'ROOM_FULL', message: 'Room is full.' }); return; }

    const team = lobby.players.filter(p => p.team === 'A').length <= lobby.players.filter(p => p.team === 'B').length ? 'A' : 'B';
    lobby.players.push({ id: socket.id, name: playerName, team, ready: false });
    socketToRoom[socket.id] = roomCode;
    socket.join(roomCode);
    broadcastLobbyState(roomCode);
  });

  socket.on('lobby:set_map', ({ mapId }) => {
    const code = socketToRoom[socket.id];
    const lobby = getLobby(code);
    if (!lobby || lobby.host !== socket.id) return;
    // Empty / null / "random" all mean "let the server pick at start".
    if (!mapId || mapId === 'random') {
      lobby.mapId = null;
    } else if (AVAILABLE_MAPS.some(m => m.id === mapId)) {
      lobby.mapId = mapId;
    } else {
      socket.emit('error', { code: 'BAD_MAP', message: 'Unknown map.' });
      return;
    }
    broadcastLobbyState(code);
  });

  socket.on('queue:join', ({ playerName }) => {
    joinQueue(socket, playerName, (matchedPlayers) => {
      const code = generateRoomCode(existingCodes);
      existingCodes.add(code);
      lobbies[code] = {
        players: matchedPlayers.map(p => ({ id: p.socket.id, name: p.playerName, team: p.team, ready: true })),
        host: matchedPlayers[0].socket.id,
        mapId: null, // public matches always randomise
      };
      for (const mp of matchedPlayers) {
        socketToRoom[mp.socket.id] = code;
        mp.socket.join(code);
      }
      startGame(code);
    });
  });

  socket.on('game:ready', () => {
    const code = socketToRoom[socket.id];
    const lobby = getLobby(code);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (player) player.ready = true;
    const allReady = lobby.players.every(p => p.ready);
    io.to(code).emit('lobby:state', {
      roomCode: code,
      players: lobby.players,
      host: lobby.host,
      mapId: lobby.mapId,
      availableMaps: AVAILABLE_MAPS,
      allReady,
    });
  });

  socket.on('game:start_request', () => {
    const code = socketToRoom[socket.id];
    const lobby = getLobby(code);
    if (!lobby || lobby.host !== socket.id) return;
    if (lobby.players.length < 2) { socket.emit('error', { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 2 players.' }); return; }
    startGame(code);
  });

  socket.on('player:input', ({ dx, dy }) => {
    const code = socketToRoom[socket.id];
    const room = gameLoop.getRoom(code);
    if (!room) return;
    room.applyInput(socket.id, dx || 0, dy || 0);
  });

  socket.on('disconnect', () => {
    leaveQueue(socket);
    const code = socketToRoom[socket.id];
    if (!code) return;
    delete socketToRoom[socket.id];

    const lobby = getLobby(code);
    if (lobby) {
      lobby.players = lobby.players.filter(p => p.id !== socket.id);
      if (lobby.host === socket.id && lobby.players.length > 0) {
        lobby.host = lobby.players[0].id;
      }
      if (lobby.players.length === 0) {
        delete lobbies[code];
        existingCodes.delete(code);
      } else {
        broadcastLobbyState(code);
      }
      return;
    }

    const room = gameLoop.getRoom(code);
    if (room) {
      room.playerDisconnect(socket.id);
    }
  });

  socket.on('lobby:rejoin', () => {
    const code = socketToRoom[socket.id];
    const lobby = getLobby(code);
    if (!lobby) {
      socket.emit('error', { code: 'NO_REJOIN', message: 'Room no longer available.' });
      return;
    }
    if (!lobby.players.some(p => p.id === socket.id)) {
      socket.emit('error', { code: 'NOT_IN_ROOM', message: 'You are no longer in this room.' });
      return;
    }
    socket.join(code);
    broadcastLobbyState(code);
  });

  socket.on('game:reconnect', ({ roomCode }) => {
    const room = gameLoop.getRoom(roomCode);
    if (!room) { socket.emit('error', { code: 'GAME_NOT_FOUND', message: 'Game not found.' }); return; }
    const ok = room.playerReconnect(socket.id);
    if (ok) {
      socketToRoom[socket.id] = roomCode;
      socket.join(roomCode);
    } else {
      socket.emit('error', { code: 'RECONNECT_FAILED', message: 'Reconnect window expired.' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Butterfly Duel server on http://localhost:${PORT}`));
