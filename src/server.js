import express from "express";
import { fill, cancel } from "./fill.js";

// HTTP only. Everything else is in fill.js.
const app = express();
app.use(express.json());

app.post("/riders/:id", (req, res) => fill("rider", req.params.id, req.body, res));
app.post("/drivers/:id", (req, res) => fill("driver", req.params.id, req.body, res));
app.delete("/riders/:id", (req, res) => cancel("rider", req.params.id, res));
app.delete("/drivers/:id", (req, res) => cancel("driver", req.params.id, res));

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`listening on port ${PORT}`));

// Exit normally on Ctrl-C / docker stop, so things that run at exit get to run
// (e.g. `node --cpu-prof` only writes its profile on a normal exit).
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
