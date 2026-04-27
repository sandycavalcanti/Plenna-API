import { Router } from 'express';
import { CategoryController } from './category.controller.js';

export const categoryRouter = Router();

categoryRouter.get('/', CategoryController.findAll);
