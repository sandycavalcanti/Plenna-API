import { Response } from 'express';
import { CategoryService } from './category.service.js';
import { handleError } from '../../utils/handleError.js';

export class CategoryController {
  static async findAll(_req: any, res: Response) {
    try {
      const categories = await CategoryService.findAll();
      return res.status(200).json(categories);
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }
}
