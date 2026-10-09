import * as book from "./book.js";
import * as delivery from "./delivery.js";
import { rank } from "./matchers/nearest.js";

const other = { rider: "driver", driver: "rider" };
const BATCH = 5;

export async function fill(side, id, loc, res) {
  delivery.hold(side, id, res);

  const already = await book.join(side, id, loc);
  if (already) {
    return delivery.tell(side, id, { status: "matched", matchedWith: already });
  }

  const otherSide = other[side];
  const candidates = await book.nearby(otherSide, loc);
  const ranked = rank({ side, id, ...loc }, candidates);

  for (const otherId of ranked.slice(0, BATCH)) {
    const riderId = side === "rider" ? id : otherId;
    const driverId = side === "driver" ? id : otherId;
    if (await book.claim(riderId, driverId)) {
      console.log(`matched rider ${riderId} <-> driver ${driverId}`);
      delivery.tell(otherSide, otherId, { status: "matched", matchedWith: id });
      return delivery.tell(side, id, { status: "matched", matchedWith: otherId });
    }
  }
}

export async function cancel(side, id, res) {
  if (await book.cancel(side, id)) {
    delivery.tell(side, id, { status: "cancelled" });
    return res.json({ ok: true });
  }
  const matchedWith = await book.matchOf(side, id);
  res.json({ ok: false, matchedWith });
}
