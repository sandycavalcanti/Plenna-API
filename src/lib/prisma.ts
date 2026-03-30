import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { env } from "./env.js";

type PrismaRuntime = {
	client: PrismaClient;
	pool: Pool;
};

const globalForPrisma = globalThis as unknown as {
	prismaRuntime?: PrismaRuntime;
};

function createPrismaRuntime(): PrismaRuntime {
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

export async function disconnectPrisma(): Promise<void> {
	await prismaRuntime.client.$disconnect();
	await prismaRuntime.pool.end();
}