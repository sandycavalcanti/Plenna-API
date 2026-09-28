import { Router } from 'express';
import { FormaPagamentoController } from './forma-pagamento.controller.js';

export const formaPagamentoRouter = Router();

formaPagamentoRouter.get('/', FormaPagamentoController.findAll);
