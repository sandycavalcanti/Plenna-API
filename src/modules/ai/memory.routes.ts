import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { MemoryController } from './memory.controller.js';

export const memoryRouter = Router();

memoryRouter.use(authMiddleware);
memoryRouter.get('/', MemoryController.list);
memoryRouter.post('/', MemoryController.create);
memoryRouter.patch('/:memoriaId', MemoryController.update);
memoryRouter.post('/:memoriaId/inativar', MemoryController.inactivate);
memoryRouter.delete('/:memoriaId', MemoryController.delete);
