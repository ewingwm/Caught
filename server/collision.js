// Collision helpers parameterised by a map. The map shape is described in
// server/maps/meadow.js — obstacles, optional stream, dimensions, etc.

const PLAYER_RADIUS = 16;

function collidesWithObstacles(x, y, radius, map) {
  for (const obs of map.obstacles) {
    const dx = x - obs.x, dy = y - obs.y;
    const minDist = radius + obs.r;
    if (dx * dx + dy * dy < minDist * minDist) return obs;
  }
  if (map.stream && isBlockedByStream(x, y, radius, map.stream)) return { type: 'stream' };
  return null;
}

// Streams are line segments with halfWidth and a list of crossings parameterised
// by `t` (0..1 along the segment) and `halfLen` (gap size along the segment).
function isBlockedByStream(x, y, radius, stream) {
  const dx = stream.endX - stream.startX;
  const dy = stream.endY - stream.startY;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return false;
  const tRaw = ((x - stream.startX) * dx + (y - stream.startY) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const cx = stream.startX + t * dx;
  const cy = stream.startY + t * dy;
  const perpDist = Math.hypot(x - cx, y - cy);
  if (perpDist > stream.halfWidth + radius) return false;
  const len = Math.sqrt(lenSq);
  for (const c of (stream.crossings || [])) {
    if (Math.abs(t - c.t) * len < c.halfLen) return false;
  }
  return true;
}

function resolveObstacleSlide(x, y, nx, ny, radius, map, extraCircles) {
  const blocked = (px, py) => {
    if (collidesWithObstacles(px, py, radius, map)) return true;
    if (extraCircles) {
      for (const c of extraCircles) {
        const minDist = radius + c.r;
        if ((px - c.x) * (px - c.x) + (py - c.y) * (py - c.y) < minDist * minDist) return true;
      }
    }
    return false;
  };
  if (!blocked(nx, ny)) return { x: nx, y: ny };
  if (!blocked(nx, y))  return { x: nx, y };
  if (!blocked(x,  ny)) return { x,  y: ny };
  return { x, y };
}

function clampToMap(x, y, radius, map) {
  return {
    x: Math.max(radius, Math.min(map.width  - radius, x)),
    y: Math.max(radius, Math.min(map.height - radius, y)),
  };
}

module.exports = {
  PLAYER_RADIUS,
  collidesWithObstacles,
  isBlockedByStream,
  resolveObstacleSlide,
  clampToMap,
};
