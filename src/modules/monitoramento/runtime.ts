import { prisma } from '../../lib/prisma.js';
import { monitoringRepository } from './postgres.js';
import { MonitoringService } from './service.js';
let instance: MonitoringService | undefined;
export const getMonitoringService = () => instance ??= new MonitoringService(monitoringRepository(prisma));
