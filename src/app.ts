import express from "express";
import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { usersRouter } from "./modules/user/user.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/users", usersRouter);
app.use("/auth", authRouter);

app.get("/", (_req, res) => {
  res.json({
    service: "Plenna API",
    status: "ok",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled application error", err);

  res.status(500).json({
    error: "Internal server error",
  });
});

export default app;