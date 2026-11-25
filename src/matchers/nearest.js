// A matcher only puts candidates in order, best first. It never reads or changes the book,
// so it can't break correctness, only make worse matches.
//
// This one: closest first.
export function rank(order, candidates) {
  const sorted = [...candidates].sort((a, b) => a.distKm - b.distKm);
  return sorted.map((c) => c.id);
}
