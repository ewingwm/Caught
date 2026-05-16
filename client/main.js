import * as Input    from './input.js';
import * as Renderer from './renderer.js';
import * as UI       from './ui.js';

const socket = io();
const canvas = document.getElementById('canvas');

let myId   = null;
let myTeam = null;
let myName = '';
let inGame = false;
let flowers = []; // client-side flower list maintained from powerup events
let powerupMaxDuration = { white_trillium: 5, pink_trillium: 6, red_trillium: 5 };
let myPowerupMax = 5;

UI.init();

// ── Menu buttons ──────────────────────────────────────────────────────────────

document.getElementById('btn-create').addEventListener('click', () => {
  const name = getNameOrError('error-msg');
  if (!name) return;
  myName = name;
  socket.emit('lobby:create', { playerName: name });
});

document.getElementById('btn-join-toggle').addEventListener('click', () => UI.show('screen-join'));
document.getElementById('btn-join-back').addEventListener('click', () => UI.show('screen-menu'));

document.getElementById('btn-join-submit').addEventListener('click', () => {
  const name = getNameOrError('error-msg-join');
  if (!name) return;
  const code = document.getElementById('room-code-input').value.toUpperCase().trim();
  if (code.length !== 6) { UI.setError('error-msg-join', 'Enter a 6-character code.'); return; }
  myName = name;
  socket.emit('lobby:join', { roomCode: code, playerName: name });
});

document.getElementById('btn-queue').addEventListener('click', () => {
  const name = getNameOrError('error-msg');
  if (!name) return;
  myName = name;
  socket.emit('queue:join', { playerName: name });
  UI.show('screen-queue');
});

document.getElementById('btn-leave-queue').addEventListener('click', () => {
  socket.emit('queue:leave');
  UI.show('screen-menu');
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('game:start_request');
});

document.getElementById('map-select').addEventListener('change', (e) => {
  socket.emit('lobby:set_map', { mapId: e.target.value });
});

document.getElementById('btn-leave').addEventListener('click', () => {
  socket.disconnect();
  location.reload();
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  socket.disconnect();
  location.reload();
});

document.getElementById('btn-stay-in-room').addEventListener('click', () => {
  socket.emit('lobby:rejoin');
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => { myId = socket.id; });

let signalledReady = false;
socket.on('lobby:state', (data) => {
  UI.show('screen-lobby');
  UI.renderLobby(data, myId);
  if (!signalledReady) {
    signalledReady = true;
    socket.emit('game:ready');
  }
});

socket.on('game:countdown', ({ countdown }) => {
  UI.showCountdown(countdown);
});

socket.on('game:start', ({ map, teamAssignments }) => {
  const assignment = teamAssignments.find(a => a.id === myId);
  myTeam = assignment ? assignment.team : 'A';
  flowers = [];
  inGame = true;
  signalledReady = false;
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  UI.showHUD(true);
  UI.showMapName(map.name);
  Renderer.init(canvas, map, myId, myTeam);
  Renderer.start();
  Input.init((dx, dy) => socket.emit('player:input', { dx, dy }));
  UI.showCountdown('GO!');
});

socket.on('game:tick', (state) => {
  if (!inGame) return;
  // Attach flower list to state for renderer
  state.flowers = flowers;
  Renderer.pushState(state);

  // Update HUD for local player
  const me = state.players.find(p => p.id === myId);
  if (me) {
    if (me.powerup && me.powerup !== lastPowerup) {
      myPowerupMax = powerupMaxDuration[me.powerup] || 5;
    }
    lastPowerup = me.powerup;
    Renderer.updateHUD(state, myTeam, me.powerup, me.powerupRemaining, myPowerupMax);
  }
});

let lastPowerup = null;

socket.on('game:end', (data) => {
  inGame = false;
  Input.stop();
  Renderer.stop();
  UI.showHUD(false);
  UI.showEndScreen(data, myTeam);
});

socket.on('powerup:spawn', (flower) => {
  flowers.push({ id: flower.id, type: flower.type, x: flower.position.x, y: flower.position.y });
});

socket.on('powerup:collected', ({ id }) => {
  flowers = flowers.filter(f => f.id !== id);
});

socket.on('player:banked', ({ playerId, count }) => {
  const color = playerId === myId ? '#ffd060' : '#a0d070';
  const text  = playerId === myId ? `+${count} banked!` : `Team banked ${count}!`;
  Renderer.pushNotification(text, 800, 500, color);
});

socket.on('player:stolen', ({ victimId, thiefId, count }) => {
  const color = victimId === myId ? '#ff6060' : thiefId === myId ? '#60ff60' : '#ffffff';
  const text   = victimId === myId ? `Stolen! -${count}` : thiefId === myId ? `Stole ${count}!` : null;
  if (text) Renderer.pushNotification(text, 800, 300, color);
});

socket.on('error', ({ message }) => {
  // Show error on whichever screen is active
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const errEl = active.querySelector('[id^="error-msg"]');
  if (errEl) errEl.textContent = message;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNameOrError(errElId) {
  const input = document.getElementById('player-name');
  const val = (input ? input.value.trim() : '') || myName;
  if (!val) { UI.setError(errElId, 'Please enter your name.'); return null; }
  if (val.length > 16) { UI.setError(errElId, 'Name too long (max 16 chars).'); return null; }
  UI.setError(errElId, '');
  return val;
}
