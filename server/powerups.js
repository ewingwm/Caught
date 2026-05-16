let nextId = 1;

const TYPES = ['white_trillium', 'pink_trillium', 'red_trillium'];

function createFlower(map, pointIndex) {
  const pt = map.powerupSpawns[pointIndex];
  return {
    id: nextId++,
    type: TYPES[Math.floor(Math.random() * TYPES.length)],
    x: pt.x,
    y: pt.y,
    pointIndex,
  };
}

function initFlowers(map) {
  return map.powerupSpawns.map((_, i) => createFlower(map, i));
}

// Returns a new flower to add after respawn delay, or null if all points occupied.
function pickRespawnPoint(flowers, map) {
  const occupied = new Set(flowers.map(f => f.pointIndex));
  const free = map.powerupSpawns.map((_, i) => i).filter(i => !occupied.has(i));
  if (free.length === 0) return null;
  const idx = free[Math.floor(Math.random() * free.length)];
  return createFlower(map, idx);
}

const EFFECT_DURATION = {
  white_trillium: 5,
  pink_trillium: 5,
  red_trillium: 5,
};

module.exports = { initFlowers, pickRespawnPoint, EFFECT_DURATION };
