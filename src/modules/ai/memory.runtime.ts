import { prisma } from '../../lib/prisma.js';
import { aiToolRegistry } from './ai.registry.js';
import { resolveMemoryAuthorization } from './memory.authorization.js';
import { PrismaMemoryRepository } from './prisma-memory.repository.js';
import { MemoryService } from './memory.service.js';
import { createAutomaticMemoryToolDefinition, registerMemoryTools } from './memory.tools.js';
import { createFinancialToolDefinitions } from './financial.tools.js';
import { AutomaticMemoryService } from './memory.automatic.js';

export const memoryRepository = new PrismaMemoryRepository(prisma);
export const memoryService = new MemoryService(memoryRepository);
export const automaticMemoryService = new AutomaticMemoryService(
  memoryService,
  resolveMemoryAuthorization,
);
export const automaticMemoryToolDefinition = createAutomaticMemoryToolDefinition(automaticMemoryService);

registerMemoryTools(aiToolRegistry, memoryService, resolveMemoryAuthorization);

for (const definition of createFinancialToolDefinitions()) {
  if (!aiToolRegistry.has(definition.name)) aiToolRegistry.register(definition);
}
