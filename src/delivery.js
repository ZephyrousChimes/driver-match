const LONG_POLL_MS = 25_000;

const pending = { rider: new Map(), driver: new Map() };

export function hold(side, id, res) {
  pending[side].get(id)?.json({ status: "waiting" });
  pending[side].set(id, res);
  const timer = setTimeout(() => res.json({ status: "waiting" }), LONG_POLL_MS);

  res.on("close", () => {
    clearTimeout(timer);
    if (pending[side].get(id) === res) pending[side].delete(id);
  });
}

export function tell(side, id, message) {
  pending[side].get(id)?.json(message);
}
