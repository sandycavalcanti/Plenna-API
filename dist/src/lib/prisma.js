import { PrismaPg } from "@prisma/adapter-pg";
import * as prismaClientPackage from "@prisma/client";
import { Pool } from "pg";
import { env } from "./env.js";
// Prisma's module shape can vary between ESM/CJS toolchains; resolve safely.
const PrismaClientCtor = prismaClientPackage.PrismaClient ??
    prismaClientPackage.default?.PrismaClient;
if (!PrismaClientCtor) {
    throw new Error("Unable to load PrismaClient from @prisma/client");
}
const PrismaClient = PrismaClientCtor;
const globalForPrisma = globalThis;
function createPrismaRuntime() {
    const pool = new Pool({
        connectionString: env.dbUrl,
        max: env.isProduction ? 20 : 10,
    });
    const adapter = new PrismaPg(pool);
    const client = new PrismaClient({ adapter });
    return { client, pool };
}
const prismaRuntime = globalForPrisma.prismaRuntime ?? createPrismaRuntime();
if (!env.isProduction) {
    globalForPrisma.prismaRuntime = prismaRuntime;
}
export const prisma = prismaRuntime.client;
export async function disconnectPrisma() {
    await prismaRuntime.client.$disconnect();
    await prismaRuntime.pool.end();
}
