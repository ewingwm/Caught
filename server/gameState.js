const {
  BASE_RADIUS, COLLECTION_RADIUS, SPEED_NORMAL,
  SPEED_MAX_PENALTY, ACCEL_TIME_SEC, STOP_DAMPING_SEC, TRAIL_SPACING, BUTTERFLY_TARGET_COUNT,
  BUTTERFLY_RESPAWN_DELAY_SEC, POWERUP_RESPAWN_SEC, MAGNET_RADIUS,
  BASE_IMMUNITY_SEC, ROUND_DURATION, DISCONNECT_HOLD_SEC,
} = require('./config');
const { EFFECT_DURATION, initFlowers, pickRespawnPoint } = require('./powerups');
const butterflyMod = require('./butterfly');
const { resolveObstacleSlide, clampToMap, PLAYER_RADIUS } = require('./collision');
const { checkTheft } = require('./theft');

// Spawn positions inside each team's base. Players are arranged in a line
// perpendicular to the base-enemy axis so they all start within the base
// radius (their own base also functions as an enemy exclusion zone).
function spawnPositions(map, team, count) {
  const base = map.bases[team];
  const otherTeam = team === 'A' ? 'B' : 'A';
  const other = map.bases[otherTeam];
  const dx = Math.sign(other.x - base.x) || 1;
  const dy = Math.sign(other.y - base.y) || 0;
  const positions = [];
  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * 40;
    const px = base.x - dy * offset;
    const py = base.y + dx * offset;
    positions.push({ x: px, y: py });
  }
  return positions;
}

function createPlayer(id, name, team, spawnPos, facingAngle) {
  return {
    id,
    name,
    team,
    x: spawnPos.x,
    y: spawnPos.y,
    angle: facingAngle,
    trail: [],          // array of butterfly objects (in-trail)
    pathHistory: [],    // array of {x,y} for trail rendering
    powerup: null,
    powerupRemaining: 0,
    shielded: false,
    immuneUntil: 0,
    disconnected: false,
    disconnectAt: null,
    dx: 0,
    dy: 0,
    vx: 0,
    vy: 0,
  };
}

class GameRoom {
  constructor(roomCode, players, map) {
    this.roomCode = roomCode;
    this.map = map;
    this.players = {};   // id -> player
    this.butterflies = {};  // id -> butterfly
    this.flowers = {};   // id -> flower
    this.scores = { A: 0, B: 0 };
    this.timeRemaining = ROUND_DURATION;
    this.tick = 0;
    this.respawnQueue = []; // { at: timestamp }
    this.flowerRespawnQueue = []; // { at: timestamp }
    this.phase = 'playing';
    this.io = null;

    const teamA = players.filter(p => p.team === 'A');
    const teamB = players.filter(p => p.team === 'B');
    const posA = spawnPositions(map, 'A', teamA.length);
    const posB = spawnPositions(map, 'B', teamB.length);
    const angleA = Math.atan2(map.bases.B.y - map.bases.A.y, map.bases.B.x - map.bases.A.x);
    const angleB = angleA + Math.PI;

    teamA.forEach((p, i) => {
      this.players[p.id] = createPlayer(p.id, p.name, 'A', posA[i], angleA);
    });
    teamB.forEach((p, i) => {
      this.players[p.id] = createPlayer(p.id, p.name, 'B', posB[i], angleB);
    });

    for (let i = 0; i < BUTTERFLY_TARGET_COUNT; i++) {
      const b = butterflyMod.create(this.map);
      this.butterflies[b.id] = b;
    }

    for (const f of initFlowers(this.map)) {
      this.flowers[f.id] = f;
    }
  }

  setIO(io) { this.io = io; }

  applyInput(playerId, dx, dy) {
    const p = this.players[playerId];
    if (!p || p.disconnected) return;
    p.dx = Math.max(-1, Math.min(1, dx));
    p.dy = Math.max(-1, Math.min(1, dy));
  }

  update(dt) {
    if (this.phase !== 'playing') return;
    this.tick++;
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.phase = 'ended';
      return;
    }

    const now = Date.now();

    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      if (now >= this.respawnQueue[i].at) {
        const b = butterflyMod.create(this.map);
        this.butterflies[b.id] = b;
        this.respawnQueue.splice(i, 1);
      }
    }

    for (let i = this.flowerRespawnQueue.length - 1; i >= 0; i--) {
      const entry = this.flowerRespawnQueue[i];
      if (now >= entry.at) {
        const f = pickRespawnPoint(Object.values(this.flowers), this.map);
        if (f) {
          this.flowers[f.id] = f;
          if (this.io) this.io.to(this.roomCode).emit('powerup:spawn', { id: f.id, type: f.type, position: { x: f.x, y: f.y } });
        }
        this.flowerRespawnQueue.splice(i, 1);
      }
    }

    for (const p of Object.values(this.players)) {
      if (p.disconnected && now - p.disconnectAt > DISCONNECT_HOLD_SEC * 1000) {
        delete this.players[p.id];
      }
    }

    for (const b of Object.values(this.butterflies)) {
      butterflyMod.update(b, dt, this.map);
    }

    for (const p of Object.values(this.players)) {
      if (p.disconnected) continue;
      this._updatePlayer(p, dt, now);
    }

    const playerList = Object.values(this.players).filter(p => !p.disconnected);
    for (const thief of playerList) {
      for (const victim of playerList) {
        if (thief.id === victim.id || victim.trail.length === 0) continue;
        const trailPos = this._trailPositions(victim);
        if (checkTheft(thief, victim, trailPos)) {
          const stolen = victim.trail.splice(0);
          thief.trail.push(...stolen);
          if (this.io) {
            this.io.to(this.roomCode).emit('player:stolen', { victimId: victim.id, thiefId: thief.id, count: stolen.length });
          }
        }
      }
    }

    const freeCount = Object.keys(this.butterflies).length;
    const pending = this.respawnQueue.length;
    const needed = BUTTERFLY_TARGET_COUNT - freeCount - pending;
    for (let i = 0; i < needed; i++) {
      this.respawnQueue.push({ at: now + BUTTERFLY_RESPAWN_DELAY_SEC * 1000 });
    }
  }

  _updatePlayer(p, dt, now) {
    if (p.powerup) {
      p.powerupRemaining -= dt;
      if (p.powerupRemaining <= 0) {
        p.powerup = null;
        p.powerupRemaining = 0;
        p.shielded = false;
      }
    }

    let speed = SPEED_NORMAL;
    const trailCount = p.trail.length;
    if (trailCount >= 10) speed *= SPEED_MAX_PENALTY;
    else if (trailCount > 0) speed *= 1 - (1 - SPEED_MAX_PENALTY) * (trailCount / 10);
    if (p.powerup === 'white_trillium') speed *= 1.5;
    if (p.powerup === 'pink_trillium') {
      for (const b of Object.values(this.butterflies)) {
        const dist = Math.hypot(b.x - p.x, b.y - p.y);
        if (dist < MAGNET_RADIUS && dist > 1) {
          const pull = 80 * dt;
          b.x += ((p.x - b.x) / dist) * pull;
          b.y += ((p.y - b.y) / dist) * pull;
        }
      }
    }

    const mag = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
    if (mag >= 0.01) {
      const ndx = p.dx / mag;
      const ndy = p.dy / mag;
      const targetVx = ndx * speed;
      const targetVy = ndy * speed;
      const alpha = 1 - Math.exp(-dt / ACCEL_TIME_SEC);
      p.vx += (targetVx - p.vx) * alpha;
      p.vy += (targetVy - p.vy) * alpha;
      p.angle = Math.atan2(ndy, ndx);
    } else {
      const decay = Math.exp(-dt / STOP_DAMPING_SEC);
      p.vx *= decay;
      p.vy *= decay;
    }

    const speedNow = Math.hypot(p.vx, p.vy);
    if (speedNow < 1) {
      p.vx = 0;
      p.vy = 0;
      return;
    }

    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;

    const enemyBase = this.map.bases[p.team === 'A' ? 'B' : 'A'];
    const enemyZone = [{ x: enemyBase.x, y: enemyBase.y, r: BASE_RADIUS }];
    const resolved = resolveObstacleSlide(p.x, p.y, nx, ny, PLAYER_RADIUS, this.map, enemyZone);
    const clamped = clampToMap(resolved.x, resolved.y, PLAYER_RADIUS, this.map);
    if (clamped.x === p.x && clamped.y === p.y) {
      p.vx = 0;
      p.vy = 0;
    }
    p.x = clamped.x;
    p.y = clamped.y;

    p.pathHistory.unshift({ x: p.x, y: p.y });
    const maxHistory = (p.trail.length + 2) * TRAIL_SPACING * 2;
    if (p.pathHistory.length > Math.max(200, maxHistory)) p.pathHistory.length = Math.max(200, maxHistory);

    const collectR2 = COLLECTION_RADIUS * COLLECTION_RADIUS;
    for (const [bid, b] of Object.entries(this.butterflies)) {
      if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 < collectR2) {
        p.trail.push(b);
        delete this.butterflies[bid];
      }
    }

    const base = this.map.bases[p.team];
    const distToBase = Math.hypot(p.x - base.x, p.y - base.y);
    if (distToBase < BASE_RADIUS && p.trail.length > 0) {
      const pts = p.trail.length;
      p.trail = [];
      p.pathHistory = [];
      this.scores[p.team] += pts;
      if (this.io) {
        this.io.to(this.roomCode).emit('player:banked', { playerId: p.id, count: pts, teamScore: this.scores[p.team] });
      }
    }

    const distToEnemy = Math.hypot(p.x - enemyBase.x, p.y - enemyBase.y);
    if (distToBase < BASE_RADIUS || distToEnemy < BASE_RADIUS) {
      p.immuneUntil = now + BASE_IMMUNITY_SEC * 1000;
    }

    for (const [fid, f] of Object.entries(this.flowers)) {
      if ((p.x - f.x) ** 2 + (p.y - f.y) ** 2 < 40 * 40) {
        p.powerup = f.type;
        p.powerupRemaining = EFFECT_DURATION[f.type];
        p.shielded = f.type === 'red_trillium';
        delete this.flowers[fid];
        if (this.io) this.io.to(this.roomCode).emit('powerup:collected', { id: f.id, playerId: p.id });
        this.flowerRespawnQueue.push({ at: now + POWERUP_RESPAWN_SEC * 1000 });
      }
    }
  }

  _trailPositions(player) {
    const positions = [];
    const hist = player.pathHistory;
    for (let i = 0; i < player.trail.length; i++) {
      const targetDist = (i + 1) * TRAIL_SPACING;
      let accumulated = 0;
      for (let h = 0; h < hist.length - 1; h++) {
        const segLen = Math.hypot(hist[h + 1].x - hist[h].x, hist[h + 1].y - hist[h].y);
        if (accumulated + segLen >= targetDist) {
          const t = (targetDist - accumulated) / segLen;
          positions.push({
            x: hist[h].x + (hist[h + 1].x - hist[h].x) * t,
            y: hist[h].y + (hist[h + 1].y - hist[h].y) * t,
          });
          break;
        }
        accumulated += segLen;
      }
      if (positions.length <= i) positions.push(hist[hist.length - 1] || { x: player.x, y: player.y });
    }
    return positions;
  }

  getTickState() {
    const players = Object.values(this.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: p.x,
      y: p.y,
      angle: p.angle,
      trailLength: p.trail.length,
      trailPositions: this._trailPositions(p),
      powerup: p.powerup,
      powerupRemaining: p.powerupRemaining,
      shielded: p.shielded,
      disconnected: p.disconnected,
    }));
    const butterflies = Object.values(this.butterflies).map(b => ({ id: b.id, type: b.type, x: b.x, y: b.y }));
    return {
      tick: this.tick,
      players,
      butterflies,
      scores: this.scores,
      timeRemaining: this.timeRemaining,
    };
  }

  playerDisconnect(playerId) {
    const p = this.players[playerId];
    if (!p) return;
    for (const b of p.trail) {
      b.x = p.x + (Math.random() - 0.5) * 40;
      b.y = p.y + (Math.random() - 0.5) * 40;
      this.butterflies[b.id] = b;
    }
    p.trail = [];
    p.disconnected = true;
    p.disconnectAt = Date.now();
  }

  playerReconnect(playerId) {
    const p = this.players[playerId];
    if (!p) return false;
    p.disconnected = false;
    p.disconnectAt = null;
    return true;
  }
}

module.exports = { GameRoom };
