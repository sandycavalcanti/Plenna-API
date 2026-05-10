import { FormaPagamentoService } from './forma-pagamento.service.js';
export class FormaPagamentoController {
    static async findAll(_req, res) {
        try {
            const formasPagamento = await FormaPagamentoService.findAll();
            return res.status(200).json(formasPagamento);
        }
        catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
}
