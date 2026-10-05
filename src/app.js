import { getSpotBalances, getApiPermissions } from "./binance.js";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "P2connect" }));
  app.get("/api/status", (_req, res) => res.json({
    status: "ok",
    service: "P2connect",
    system: "P2P-TRADERS",
    binanceConfigured: Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_PRIVATE_KEY),
    timestamp: new Date().toISOString()
  }));

  function auth(req, res, next) {
    const expected = process.env.P2CONNECT_API_TOKEN;
    if (!expected) return res.status(503).json({ status: "CONFIGURATION_REQUIRED" });
    if (req.get("authorization") !== `Bearer ${expected}`)
      return res.status(401).json({ error: "unauthorized" });
    next();
  }

  app.get("/api/balances", auth, (_req, res) => {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_PRIVATE_KEY)
      return res.status(503).json({ status: "CONFIGURATION_REQUIRED" });
    res.status(501).json({ status: "READ_ONLY_ADAPTER_PENDING" });
  });
  app.get("/api/market/status", (_req, res) => res.json({ status: "NO_DATA" }));
  app.get("/api/p2p/summary", auth, (_req, res) => res.json({ status: "NO_DATA" }));
  return app;
}
