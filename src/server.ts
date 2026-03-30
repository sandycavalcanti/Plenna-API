import app from "./app.js";
import { env } from "./lib/env.js";
import { disconnectPrisma } from "./lib/prisma.js";

const server = app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
});

let isShuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Shutting down server (${reason})`);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  await disconnectPrisma();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  void shutdown("uncaughtException");
});