// The order book: the shared truth, stored in Redis.
// This is the only file that knows the Redis keys, and every atomic step is in here.
//
// Two maps per side (rider, driver):
//   1. waiting   who is waiting, and where
//   2. outbox    who got matched with whom
//   3. both      steps that change both maps at once (Lua scripts)

import { redis } from "./redis.js";

// ===========================================================================
// 1. WAITING
//    keys:  waiting:rider, waiting:driver
//    type:  geo set (a sorted set underneath, so ZSCORE / ZREM work on it)
//    holds: id -> location
// ===========================================================================

const waitingKey = (side) => `waiting:${side}`;

const RADIUS_KM = 10; // further than this, keep waiting

// Who on `side` is waiting within RADIUS_KM of this point? -> [{ id, distKm }]
// Just a snapshot: by the time we act on it, someone in it may be gone. claim() checks again.
export async function nearby(side, { lat, lon }) {
  const rows = await redis.sendCommand([
    "GEOSEARCH", waitingKey(side),
    "FROMLONLAT", String(lon), String(lat), // Redis wants longitude first
    "BYRADIUS", String(RADIUS_KM), "km",
    "WITHDIST",
  ]);
  return rows.map(([id, dist]) => ({ id, distKm: Number(dist) }));
}

// Leave waiting. One command, so atomic on its own.
// Returns false if you weren't waiting (e.g. you were matched a moment ago).
export async function cancel(side, id) {
  const removed = await redis.zRem(waitingKey(side), id);
  return removed === 1;
}

// ===========================================================================
// 2. OUTBOX
//    keys:  outbox:rider, outbox:driver
//    type:  hash
//    holds: id -> the id they were matched with
// ===========================================================================

const outboxKey = (side) => `outbox:${side}`;

// Who was this id matched with? null if nobody.
// Safe to read any time: once a match is written, it never changes.
export async function matchOf(side, id) {
  return redis.hGet(outboxKey(side), id);
}

// ===========================================================================
// 3. BOTH MAPS AT ONCE: Lua scripts
//    Redis runs each script start to finish, with no other command in between.
//    Inside a script, KEYS[n] and ARGV[n] are the keys and arguments we pass in.
// ===========================================================================

// join: "I'm here." If I was already matched, return who with. Otherwise add me to waiting.
//   reads:  outbox:<side>
//   writes: waiting:<side>
//
// Why one script: if "am I matched?" and "add me" were two separate commands, another server
// could match me in between. I'd be added back to waiting while already matched,
// and the next person could match me again.
const JOIN = `
  local match = redis.call('HGET', KEYS[1], ARGV[1])       -- outbox: am I already matched?
  if match then
    return match                                           -- yes: return who with
  end
  redis.call('GEOADD', KEYS[2], ARGV[2], ARGV[3], ARGV[1]) -- no: add me (or move me) in waiting
  return false
`;

export async function join(side, id, { lat, lon }) {
  return redis.eval(JOIN, {
    keys: [outboxKey(side), waitingKey(side)], // KEYS[1], KEYS[2]
    arguments: [id, String(lon), String(lat)], // ARGV[1], ARGV[2], ARGV[3] (longitude first)
  });
}

// claim: take this rider and this driver together, if both are still waiting.
//   reads + writes: waiting:rider, waiting:driver
//   writes:         outbox:rider, outbox:driver
// Returns true if we got them, false if someone else got one of them first (try the next candidate).
//
// Why one script: if "are both still waiting?" and "take both" were separate commands,
// two servers could both see the same driver as free, and both take him.
const CLAIM = `
  if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end -- rider still waiting? no: stop
  if not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end -- driver still waiting? no: stop
  redis.call('ZREM', KEYS[1], ARGV[1])                            -- take rider out of waiting
  redis.call('ZREM', KEYS[2], ARGV[2])                            -- take driver out of waiting
  redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])                   -- outbox: rider -> driver
  redis.call('HSET', KEYS[4], ARGV[2], ARGV[1])                   -- outbox: driver -> rider
  return 1
`;

export async function claim(riderId, driverId) {
  const got = await redis.eval(CLAIM, {
    keys: [waitingKey("rider"), waitingKey("driver"), outboxKey("rider"), outboxKey("driver")], // KEYS[1..4]
    arguments: [riderId, driverId], // ARGV[1], ARGV[2]
  });
  return got === 1;
}
