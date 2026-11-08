import { prisma } from '../../lib/prisma.js';
import { postgresRepository } from './postgres.js';
import { UsageService } from './service.js';
let instance;
export const getUsageService = () => instance ?? (instance = new UsageService(postgresRepository(prisma), process.env.RF017_RECEIPT_SECRET ?? process.env.JWT_SECRET ?? ''));
