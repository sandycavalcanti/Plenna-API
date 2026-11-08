import { prisma } from '../../lib/prisma.js';
import { monitoringRepository } from './postgres.js';
import { MonitoringService } from './service.js';
let instance;
export const getMonitoringService = () => instance ?? (instance = new MonitoringService(monitoringRepository(prisma)));
