import { FormaPagamentoService } from './forma-pagamento.service.js';
import { handleError } from '../../utils/handleError.js';
export class FormaPagamentoController {
    static async findAll(_req, res) {
        try {
            const formasPagamento = await FormaPagamentoService.findAll();
            return res.status(200).json(formasPagamento);
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
}
