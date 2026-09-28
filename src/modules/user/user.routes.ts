import { Router } from 'express';
import { UsersController } from './user.controller.js';
import { authMiddleware } from '../auth/auth.middleware.js';

export const usersRouter = Router();



usersRouter.get('/user', authMiddleware, UsersController.findByToken);
usersRouter.put('/', authMiddleware, UsersController.update);
usersRouter.delete('/', authMiddleware, UsersController.delete);
usersRouter.get('/user', authMiddleware, UsersController.findByToken);
usersRouter.put('/', authMiddleware, UsersController.update);
usersRouter.delete('/', authMiddleware, UsersController.delete);
