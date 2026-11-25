import * as book from "./book.js";
import * as delivery from "./delivery.js";
import { rank } from "./matchers/nearest.js";

const other = { rider: "driver", driver: "rider" };
const BATCH = 5; // how many candidates to try before giving up and waiting

// A "fill" order from either side. Also how a client reconnects: just send it again.
export async function fill(side, id, loc, res) {
  // Hold first, so a match made by someone else while we're busy below still reaches us.
  delivery.hold(side, id, res);

  // 1. Join the book (or learn that we were already matched).
  const already = await book.join(side, id, loc);
  if (already) {
    return delivery.tell(side, id, { status: "matched", matchedWith: already });
  }

  // 2. Ask the matcher who on the other side is best for us. Just a snapshot, no lock.
  const otherSide = other[side];
  const candidates = await book.nearby(otherSide, loc);
  const ranked = rank({ side, id, ...loc }, candidates);

  // 3. Try to claim them, best first. A failed claim means someone else got them: try the next.
  for (const otherId of ranked.slice(0, BATCH)) {
    const riderId = side === "rider" ? id : otherId;
    const driverId = side === "driver" ? id : otherId;
    if (await book.claim(riderId, driverId)) {
      console.log(`matched rider ${riderId} <-> driver ${driverId}`);
      delivery.tell(otherSide, otherId, { status: "matched", matchedWith: id });
      return delivery.tell(side, id, { status: "matched", matchedWith: otherId });
    }
  }

  // 4. Nobody claimed. We're already in the book (step 1), so just keep waiting.
}

// Leave the book (rider cancels, driver goes offline).
export async function cancel(side, id, res) {
  if (await book.cancel(side, id)) {
    delivery.tell(side, id, { status: "cancelled" });
    return res.json({ ok: true });
  }
  // Not waiting. Maybe matched a moment ago: then it's too late to cancel.
  const matchedWith = await book.matchOf(side, id);
  res.json({ ok: false, matchedWith });
}
