import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { DashboardController } from './dashboard.controller.js';

export const dashboardRouter = Router();

dashboardRouter.use(authMiddleware);

dashboardRouter.get('/gastos-categoria', DashboardController.findGastosPorCategoria);
dashboardRouter.get('/gastos-forma-pagamento', DashboardController.findGastosPorFormaPagamento);
dashboardRouter.get('/impulsividade', DashboardController.findImpulsividade);
dashboardRouter.get('/limite-compras', DashboardController.findComprasAcimaLimite);
dashboardRouter.get('/tempo-vs-gasto', DashboardController.findTempoVsGasto);
