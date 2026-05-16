const { TICK_RATE } = require('./config');

const rooms = {}; // roomCode -> GameRoom
let io = null;
let interval = null;
let onRoomEndCb = null;

function init(ioInstance, onRoomEnd) {
  io = ioInstance;
  onRoomEndCb = onRoomEnd || null;
  interval = setInterval(tick, 1000 / TICK_RATE);
}

function addRoom(room) {
  room.setIO(io);
  rooms[room.roomCode] = room;
}

function removeRoom(code) {
  delete rooms[code];
}

function getRoom(code) {
  return rooms[code] || null;
}

function tick() {
  const dt = 1 / TICK_RATE;
  for (const room of Object.values(rooms)) {
    room.update(dt);
    const state = room.getTickState();
    io.to(room.roomCode).emit('game:tick', state);

    if (room.phase === 'ended') {
      const winner = room.scores.A > room.scores.B ? 'A' : room.scores.B > room.scores.A ? 'B' : 'draw';
      io.to(room.roomCode).emit('game:end', { scores: room.scores, winner });
      if (onRoomEndCb) onRoomEndCb(room.roomCode, room);
      removeRoom(room.roomCode);
    }
  }
}

module.exports = { init, addRoom, removeRoom, getRoom };
