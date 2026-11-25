// Load test: sends driver 1, rider 1, driver 2, rider 2, ... all at the same spot,
// so every rider instantly takes the waiting driver and every request finishes fast.
//
//   node load.js [connections] [seconds]
//   node load.js 10 10
import autocannon from "autocannon";

const connections = Number(process.argv[2] ?? 10);
const duration = Number(process.argv[3] ?? 10);

let n = 0;
const body = JSON.stringify({ lat: 12.95, lon: 77.6 });

const result = await autocannon({
  url: "http://localhost:3000",
  connections, // how many requests are in flight at once
  duration,
  timeout: 2, // seconds; slower than this counts as an error
  requests: [
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      setupRequest(req) {
        n++; // 1, 2, 3, 4, ...
        const pair = Math.ceil(n / 2); // 1, 1, 2, 2, ...
        req.path = n % 2 === 1 ? `/drivers/d${pair}` : `/riders/r${pair}`;
        return req;
      },
    },
  ],
});

console.log(autocannon.printResult(result));
