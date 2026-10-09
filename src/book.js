import { redis } from "./redis.js";

const RADIUS_KM = 10;

const JOIN = `
  local match = redis.call('HGET', KEYS[1], ARGV[1])
  if match then
    return match
  end
  redis.call('GEOADD', KEYS[2], ARGV[2], ARGV[3], ARGV[1])
  return false
`;

export async function join(side, id, { lat, lon }) {
  return redis.eval(JOIN, {
    keys: [`outbox:${side}`, `waiting:${side}`],
    arguments: [id, String(lon), String(lat)],
  });
}

export async function nearby(side, { lat, lon }) {
  const rows = await redis.sendCommand([
    "GEOSEARCH", `waiting:${side}`,
    "FROMLONLAT", String(lon), String(lat),
    "BYRADIUS", String(RADIUS_KM), "km",
    "WITHDIST",
  ]);
  return rows.map(([id, dist]) => ({ id, distKm: Number(dist) }));
}

const CLAIM = `
  if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
  if not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[2])
  redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
  redis.call('HSET', KEYS[4], ARGV[2], ARGV[1])
  return 1
`;

export async function claim(riderId, driverId) {
  const got = await redis.eval(CLAIM, {
    keys: ["waiting:rider", "waiting:driver", "outbox:rider", "outbox:driver"],
    arguments: [riderId, driverId],
  });
  return got === 1;
}

export async function cancel(side, id) {
  const removed = await redis.zRem(`waiting:${side}`, id);
  return removed === 1;
}

export async function matchOf(side, id) {
  return redis.hGet(`outbox:${side}`, id);
}
