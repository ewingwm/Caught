const screens = {};

export function init() {
  for (const el of document.querySelectorAll('.screen')) {
    screens[el.id] = el;
  }
}

export function show(id) {
  for (const el of Object.values(screens)) el.classList.remove('active');
  const target = screens[id] || screens['screen-menu'];
  target.classList.add('active');
}

export function setError(elId, msg) {
  const el = document.getElementById(elId);
  if (el) el.textContent = msg || '';
}

export function renderLobby({ roomCode, players, host, allReady, mapId, availableMaps }, myId) {
  document.getElementById('room-code-display').textContent = roomCode || '';
  const container = document.getElementById('lobby-players');
  container.innerHTML = '';
  for (const p of (players || [])) {
    const div = document.createElement('div');
    div.className = `lobby-player team-${p.team.toLowerCase()}`;
    div.innerHTML = `<span>${p.name}${p.id === host ? ' <span class="host-badge">HOST</span>' : ''}</span><span>Team ${p.team}${p.ready ? ' ✓' : ''}</span>`;
    container.appendChild(div);
  }

  // Map picker — only host can interact, others see the host's selection.
  const sel = document.getElementById('map-select');
  if (availableMaps && sel.options.length !== availableMaps.length + 1) {
    sel.innerHTML = '';
    const randomOpt = document.createElement('option');
    randomOpt.value = 'random';
    randomOpt.textContent = '🎲 Random';
    sel.appendChild(randomOpt);
    for (const m of availableMaps) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
  }
  sel.value = mapId || 'random';
  sel.disabled = myId !== host;

  const startBtn = document.getElementById('btn-start');
  const waitMsg  = document.getElementById('waiting-msg');
  if (myId === host) {
    startBtn.style.display = allReady && players.length >= 2 ? 'block' : 'none';
    waitMsg.textContent = allReady ? '' : 'Waiting for all players to ready up…';
  } else {
    startBtn.style.display = 'none';
    waitMsg.textContent = 'Waiting for host to start…';
  }
}

export function showCountdown(n) {
  const el = document.getElementById('countdown-overlay');
  el.textContent = n > 0 ? n : 'GO!';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 800);
}

export function showMapName(name) {
  const el = document.getElementById('map-name-banner');
  if (!el) return;
  el.textContent = name;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

export function showEndScreen({ scores, winner }, myTeam) {
  show('screen-end');
  const titles = { A: '🏆 Team A Wins!', B: '🏆 Team B Wins!', draw: "It's a Draw!" };
  document.getElementById('end-title').textContent = titles[winner] || 'Game Over';
  document.getElementById('end-score-a-val').textContent = scores.A;
  document.getElementById('end-score-b-val').textContent = scores.B;
  document.getElementById('end-score-a').classList.toggle('winner', winner === 'A');
  document.getElementById('end-score-b').classList.toggle('winner', winner === 'B');
  const msg = document.getElementById('end-countdown-msg');
  if (msg) msg.textContent = 'Stay together for another round, or head back to the menu.';
}

export function showHUD(visible) {
  document.getElementById('hud').style.display = visible ? 'block' : 'none';
}
