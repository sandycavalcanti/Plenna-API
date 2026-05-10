import { CategoryService } from './category.service.js';
export class CategoryController {
    static async findAll(_req, res) {
        try {
            const categories = await CategoryService.findAll();
            return res.status(200).json(categories);
        }
        catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
}
