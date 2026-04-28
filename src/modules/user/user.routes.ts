import { Router } from 'express';
import { UsersController } from './user.controller.js';
import { authMiddleware } from '../auth/auth.middleware.js';

export const usersRouter = Router();

usersRouter.post('/', UsersController.create);
usersRouter.get('/', UsersController.findAll);
usersRouter.get('/id/:id', UsersController.findById);
usersRouter.get('/email/:email', UsersController.findByEmail);
usersRouter.get('/user', authMiddleware, UsersController.findUserByToken);
usersRouter.put('/', authMiddleware, UsersController.update);
usersRouter.delete('/', authMiddleware, UsersController.delete);
