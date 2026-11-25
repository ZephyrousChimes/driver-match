import { createClient } from "redis";

// One connection, shared by every file that imports it.
export const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });

redis.on("error", (err) => console.error("redis error:", err.message));

await redis.connect();
