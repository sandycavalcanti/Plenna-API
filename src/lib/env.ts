import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const portRaw = process.env.PORT ?? "3000";
const port = Number(portRaw);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: ${portRaw}`);
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  port,
  dbUrl: process.env.DIRECT_URL ?? requireEnv("DATABASE_URL"),
  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
  },
};
