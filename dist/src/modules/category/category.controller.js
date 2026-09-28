import { CategoryService } from './category.service.js';
import { handleError } from '../../utils/handleError.js';
export class CategoryController {
    static async findAll(_req, res) {
        try {
            const categories = await CategoryService.findAll();
            return res.status(200).json(categories);
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
}
