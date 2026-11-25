// Held requests (long polls). These stay in this server's memory: a connection can't move.
// Only used to deliver news. The truth is in the book.

const LONG_POLL_MS = 25_000; // under the ~60s idle timeout of typical load balancers

const pending = { rider: new Map(), driver: new Map() }; // id -> res

// Hold this request open until someone tell()s it something, or LONG_POLL_MS passes.
export function hold(side, id, res) {
  pending[side].get(id)?.json({ status: "waiting" }); // a newer request replaces an older one
  pending[side].set(id, res);
  const timer = setTimeout(() => res.json({ status: "waiting" }), LONG_POLL_MS);

  // Runs once this request is over: answered, timed out, or the client hung up.
  res.on("close", () => {
    clearTimeout(timer);
    if (pending[side].get(id) === res) pending[side].delete(id);
  });
}

// Answer this id's held request, if this server is holding one. If not, nothing happens:
// the client will ask again and find the answer in the book.
export function tell(side, id, message) {
  pending[side].get(id)?.json(message);
}
