# Decisions

One line per change: what was added, and what problem in the previous version made it necessary.

## v0 (2026-10-08)
- server.js: one Express server, everything in memory. Drivers POST their location to say they're free (DELETE to go offline). A rider POSTs /rides and immediately gets the nearest free driver, who is then removed from the free list. No database, no queue, no waiting riders: the smallest thing that matches a rider to a driver.

## pnpm (2026-10-08)
- switched from npm to pnpm (pnpm-lock.yaml; version pinned in package.json's packageManager field). Personal preference: same dependencies, faster installs. Run with `pnpm start`.

## v1: riders can wait (2026-10-08)
Problem in v0: a rider who asked when no driver was free got a flat "no free drivers" and had to try again themselves. Fixing that raised a second problem: if a rider waits, a match can happen after their request has already returned, so how do they find out?
- waiting riders: a `riders` Map. POST /rides now either matches right away or adds the rider to the map and returns 202 "waiting". When a driver comes online, they get the nearest waiting rider before joining the free list. Same "nearest" rule in both directions, shared in one `nearest()` function.
- telling the rider: polling. Matches are kept in a `matches` Map, and the rider asks GET /rides/:riderId until it says "matched". It's the simplest option: plain HTTP, nothing kept open on the server. Considered and left for later: long polling, Server-Sent Events and WebSockets (the server pushes the match the moment it happens). They only pay off once polling shows a concrete cost: many riders asking every second, or a noticeable delay between the match and the rider seeing it.

## analysis: how a rider learns about a match (2026-10-08)
No code change. Options compared, so the next step is chosen for a reason.
- short polling (current): rider asks every N sec. Stateless, so any server can answer. Cost: delay up to N sec, and most requests are wasted "still waiting".
- long polling: server holds the request until a match or ~30s timeout, then the rider asks again. Near-instant, plain HTTP, works through any proxy.
- SSE: one response kept open, server writes events into it. Server → client only. Browser reconnects by itself and can resume from Last-Event-ID. Needs a ping every ~20s or load balancers cut "idle" connections.
- WebSocket: two-way. Worth it when the client also sends constantly (a driver streaming location). Reconnect and catch-up are on us.
- mobile push (APNs/FCM): the only thing that reaches a closed app. Seconds of delay, no guarantee. Used next to a live connection, not instead of it.
Common to all of them:
- any held connection (everything except short polling) makes servers stateful: with more than one server, the server that makes the match may not hold the rider's connection, so servers need a way to pass messages (pub/sub, Kafka).
- the connection only carries the news. The match must be stored somewhere that outlives the connection, or a reconnecting rider has nothing to catch up from.
Choice for now: keep short polling (one server, few riders, nothing hurts). Likely next: SSE for riders, once polling shows a concrete cost. WebSocket if we build live driver location.

## v2: long polling (2026-10-08)
- GET /rides/:riderId now holds the request until the rider is matched (answered instantly) or 25s pass (answered "waiting"), and the rider asks again. Problem with short polling: up to N sec of delay, and most requests are wasted.
- why long polling over SSE/WebSocket: if the server crashes, the client has to reconnect anyway, so that logic must exist in the client no matter what. Long polling makes "ask again" the normal path, not a rare one: a timeout, a dropped connection and a dead server are all handled by the same loop. Plain HTTP, no special proxy/load balancer setup.
- 25s timeout: below the ~60s idle timeout of typical load balancers, so the request isn't cut silently.
- only one held request per rider: a newer poll answers the older one with "waiting". If the rider hangs up, the request is dropped from `pending` and its timer cleared.
- mobile push is the better fit for a closed app; left out as too early.

## v3: one order book for both sides (2026-10-08)
Problem in v2: riders and drivers had different code, and a driver was never told they'd been matched (their POST had already returned, and there was nothing to poll). Also, a rider needed two calls (POST /rides, then GET /rides/:id).
- riders and drivers are now two sides of one order book, like filling orders in a market. Both send the same "fill" order (POST /riders/:id or POST /drivers/:id with their location), handled by one function: (1) already matched? answer from the outbox; (2) someone waiting on the other side? match with the nearest and answer now; (3) otherwise rest in `waiting` and hold the request (long poll). Reconnecting is the same call, so there's one code path for everything.
- three kinds of state per side: `waiting` (resting orders, the truth), `outbox` (matches, kept so a reconnect still finds them), `pending` (held connections, only for delivery). Orders and connections are kept apart on purpose: a dropped connection must not cancel an order.
- the match is atomic: removing both from `waiting` and writing both outbox entries happens with no `await` in between, and Node runs one handler at a time, so no other request can see a half-done match. This stops being true once there's an `await` in that code (e.g. a Redis call) or more than one server process.
- outbox entries are not deleted when sent: the server can write "matched" just as the connection dies, so the entry stays and a reconnect gets it again (at-least-once delivery).
- invariant: at most one side of the book is non-empty. If both had someone waiting, they'd already have been matched.
- DELETE /riders/:id and /drivers/:id leave the book and answer any held request with "cancelled".

## multi-server: one server per zone (2026-10-09)
No code yet. Why more than one server at all: one Node process uses one CPU core, and if that one process dies the whole city stops. Both are true without measuring anything, so no load simulation.
- chosen: split by area (sharding). Each zone (a city, or part of one) gets its own server with its own book in RAM, and a router sends each zone's requests to its server. The code barely changes, and everything that made v3 correct stays true inside a zone: one process sees both sides of the book, holds both sides' requests, and matches atomically. No server talks to another.
- considered: a shared book in Redis (matching is no longer atomic, and servers would have to tell each other about matches) and gateways + one matcher connected by a message log (Kafka). Both bring server-to-server messaging we don't need yet.
- a held request is tied to its server and can't be moved, in any design. That's fine here: it lives at most 25s, and the client's next request can go anywhere that holds the right state. The same short life is what makes deploys and adding servers easy compared to WebSockets.

## pivot: one shared book in Redis instead of shards (2026-10-09)
Why the Redis-less design had to go: with the book in the Node process's own memory, one process = one CPU core, and that process dying stops the whole city and loses every order and match. The only way to add servers while keeping the book in their memory was sharding. This replaces the shard plan above before any of it was built. Sharding kept every server's book separate, and that forced the concessions: no matches across borders, a router that must know the map, and shard ownership to manage on failover/autoscaling. The only thing that made servers different from each other was the Maps. Moving them into one separate process (Redis) makes every Node server interchangeable: a plain load balancer, no borders, scaling = starting more copies.
- the match must move into Redis together with the Maps. As separate Redis calls, two servers could pick the same driver at the same moment. Run as one Lua script, Redis executes it start to finish with nothing in between, the same guarantee one Node process gave us.
- costs: servers must tell each other about matches (the held request may be on another server), Redis is the new single point of failure, and one Redis has a throughput ceiling (when reached, Redis itself needs sharding and borders come back). Tracked in PROBLEMS.md.

## docker (2026-10-09)
- Dockerfile for the server and compose.yaml with two services, `server` and `redis` (redis unused until the next step). Every piece runs the same way on any machine, and running more server copies becomes one setting. The server takes its port from PORT. `init: true` so Ctrl-C / docker stop actually reach Node (as process 1 it ignores them). Run with `docker compose up --build`.

## design: matching against a shared book (2026-10-09)
No code yet. Replaces "the whole match as one Lua script" from the pivot entry: that would force the matching algorithm to run inside Redis and block everything else while it runs.
- the matcher is deliberately abstract. It only ranks candidates and never touches state. The algorithm could be a fixed rule or an ML model, and the policy could be "nearest first", "whoever has waited longest first", or anything else. These have to stay easy to swap, so the matcher sits behind one small interface and the rest of the code doesn't know which one is running.
- matching is split into two stages: the matcher picks from a snapshot (no lock, can be slow), then `claim(rider, driver)` captures both atomically. `claim` checks that both are still free and only then removes both from `waiting` and writes the outbox. If the data went stale, the claim fails and the next candidate is tried (optimistic locking). The matcher returns a batch of candidates, so a lost claim falls through without re-running it.
- pessimistic locking (lock the whole book while matching) was rejected: every order in the city would wait in one line, and it would get worst exactly at busy hours, when contention is highest.
- "no match → rest" had a race: a driver arriving between the search and the rest would be missed, and both would wait. Fix without a lock: add yourself to `waiting` first, then search. Redis runs commands one at a time, so of two simultaneous arrivals at least one sees the other, and `claim` lets only one of them win. Adding yourself is guarded: if the outbox says you were just matched, return that match instead.
- a match counts once it's in the outbox, written in the same atomic step as the claim. Telling the clients happens after that and may fail: they re-poll and read the outbox.

## v4: the book moves into Redis (2026-10-09)
Builds the design above, still one server. Code is split by job, and dependencies only point one way: server → fill → (book, matcher, delivery) → redis.
- src/redis.js: one shared connection, built from REDIS_URL.
- src/book.js: the only file that knows the Redis keys, and the only place with atomic steps (`join`, `claim` as Lua scripts; `cancel` is one command). To check correctness, read this one file. Waiting orders are Redis geo sets, so distance is now real km (not flat lat/lon math) and the search only looks within 10 km.
- src/matchers/nearest.js: `rank(order, candidates)`, closest first. The only matcher for now.
- src/delivery.js: held requests, in this server's memory (connections can't move).
- src/fill.js: join → nearby → rank → claim the best 5 in turn → otherwise keep waiting. The request is held *before* the first Redis call: while we wait on Redis, another request may match us, and its news needs somewhere to go (otherwise the client only finds out on its next poll, up to 25s later).
- tested: the four earlier cases behave the same, and 20 riders racing for one driver produce exactly one match.

## measured: where the CPU goes, and where it breaks (2026-10-21)
Question: we added servers "for throughput" without checking what the work actually is.
- load.js (autocannon): driver, rider, driver, rider... all at one spot, so every request finishes fast. `node load.js <connections> <seconds>`.
- profile (`node --cpu-prof`, 10 connections, ~7.8k req/s on one process): our code is 4.7% of CPU time, the matcher 0.4%. Node's HTTP/socket work is 56%, Express 18%, the Redis client 8%. The work is moving and parsing bytes, not business logic.
- breaking point: 10 connections ~8.2k req/s, 1 ms median. 100 connections: same throughput, latency up (p97.5 31 ms), a few 2s timeouts. 1000 connections: throughput collapses to ~1.8k req/s, p97.5 1.3 s, ~1k timeouts. Redis sat at ~20-25% CPU throughout, so the Node process is the limit, not Redis.
- correction: a big city with 50k people waiting and polling every 25s is ~2k req/s, within one process. Multiple servers are justified by availability (one crash shouldn't stop the city), not throughput.
- found by load, not fixed yet: under contention, riders and drivers both end up waiting at the same spot (see PROBLEMS.md).
- small changes for this: Redis port published in compose (so a server outside Docker can reach it); the server exits normally on SIGINT/SIGTERM (the profiler only writes on a normal exit); profiles/ is gitignored.

Known problems not tackled yet live in PROBLEMS.md.
