import { prisma } from '../../lib/prisma.js';
import { aiToolRegistry } from './ai.registry.js';
import { resolveMemoryAuthorization } from './memory.authorization.js';
import { PrismaMemoryRepository } from './prisma-memory.repository.js';
import { MemoryService } from './memory.service.js';
import { registerMemoryTools } from './memory.tools.js';

export const memoryRepository = new PrismaMemoryRepository(prisma);
export const memoryService = new MemoryService(memoryRepository);

registerMemoryTools(aiToolRegistry, memoryService, resolveMemoryAuthorization);
