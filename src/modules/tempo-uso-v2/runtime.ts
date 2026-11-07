import { prisma } from '../../lib/prisma.js';
import { postgresRepository } from './postgres.js';
import { UsageService } from './service.js';
let instance:UsageService|undefined;
export const getUsageService=()=>instance??=new UsageService(postgresRepository(prisma),process.env.RF017_RECEIPT_SECRET??process.env.JWT_SECRET??'');
