# Problems

Known problems we have not tackled yet. Each one has a note on why it matters and, if we have one, an idea.
When one gets fixed, it moves to DECISIONS.md as the reason for that step.

## Losing state
- **outbox is lost when a server dies.** Worst case, one side was already told: driver d1 heard "matched r1" and starts driving, r1 never heard and gets matched again. Fix: write the match somewhere that outlives the server *before* telling either side.
- **the book is lost when a server dies,** but it rebuilds itself: every waiting client re-sends its order with its location within 25s. Only matters if 25s of missing orders is too long.
- **outbox entries are never removed.** Need an acknowledgement from the client, or an expiry time.
- **abandoned orders stay in `waiting` forever** (and can be matched to someone who already left). Need an expiry, refreshed by each new request.

## Many servers
- **a zone server dies → that zone stops** until something notices and sends its traffic elsewhere.
- **who owns which shard?** With failover or autoscaling, ownership has to move automatically, and a server that *thinks* it still owns a shard (frozen, cut off) must be stopped, or two books exist for one shard and a driver gets matched twice (split brain). Standard fix: leases/fencing from a coordinator. Don't build it: Kafka consumer groups (partition = shard) assign, reassign and fence owners for us.
- **sharing one book instead doesn't remove borders or ownership, it moves them.** A shared store (Redis) removes borders until it needs sharding itself, and it would be sharded by location, so borders come back inside it, where cross-shard operations aren't atomic. It also has to elect leaders per shard. The question is where coordination lives and whether we build or buy it.
- **no matches across zone borders.** A rider next to the border can't get the driver 200m away in the next zone. (Only at borders: we split by place, not by id, because matching asks "who's near me". Splitting by id would separate almost every pair.) Ideas:
  - draw borders where few trips cross (rivers, highways, city limits). Free, makes it rare.
  - hand-off: a rider unmatched for N seconds is *moved* to the neighbouring zone's book. The order is still in exactly one book, so matching stays atomic. Best next step if borders hurt.
  - search both sides: a match would change two servers' books at once, which needs a distributed transaction. Avoid.
  - small cells (like Uber's H3 hexagons), many per server, search the surrounding ring. Balances load, but rings span servers, which brings back "search both sides".
- **a busy zone can overload its one server,** while other zones sit idle.
- **one Node process uses one CPU core.**
- **held requests are in one server's memory.** With two servers, the match can be made on the server that isn't holding the other side's request, so it isn't told until its next poll. Next step: Redis pub/sub.
- (only if we ever share a book between servers) the server that makes a match may not be the one holding the other side's request, so servers would need to message each other. Option A (one server per zone) avoids this.

## Connections
- **thundering herd:** when a server crashes, all its clients retry at the same moment and hit the survivors together. Fix: clients wait a small random delay before retrying (jitter).
- **cost of long polling:** a fresh HTTP request every 25s per client (headers, routing, later auth). WebSockets avoid this but bring their own problems (long-lived connections, draining on deploy).
- **a closed app hears nothing.** Only mobile push (APNs/FCM) reaches it.

## Redis
- **Redis keeps everything in RAM.** If it dies, every order and the outbox are lost. The outbox is the truth about matches, so it has to be durable: Redis persistence to disk (AOF) and a replica.
- **dual write:** writing a match to Redis *and* to Kafka (or anything else) as two separate steps can leave them disagreeing after a crash in between. Fix: the transactional outbox pattern. Write the outbox in the same atomic step as the claim, and have a relay copy it to Kafka for other services.
- **high contention (busy hours):** many riders racing for few drivers means many lost claims and retries. Locking the whole map would make every rider wait in one line, exactly at peak. Better: bigger candidate batches; at the extreme, one matcher per area handling orders one at a time (single writer, e.g. one consumer per Kafka partition).

## Matching
- **the search returns everyone within 10 km.** Redis's geo index finds them quickly, but a dense downtown can return thousands, and the matcher ranks all of them.
- **the 10 km radius is fixed.** Nobody further away is ever matched, even after a long wait. A radius that grows with waiting time would fix it.
- **distance is straight-line km,** not road distance or travel time.
- **"nearest" can starve someone** far from everyone on the other side; oldest-first would be fairer.

## Security
- **no auth: anyone can send orders as any rider or driver id.** When added: 401 = who are you, 403 = not allowed. Many APIs return 404 instead of 403 so they don't reveal that the thing exists.
