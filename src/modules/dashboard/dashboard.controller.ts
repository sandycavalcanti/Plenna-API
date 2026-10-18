import type { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { analyticsQuerySchema, analyticsResponseSchema, gastosCategoriaResponseSchema, gastosFormaPagamentoResponseSchema, impulsividadeResponseSchema, limiteComprasResponseSchema, resumoMensalResponseSchema, tempoVsGastoResponseSchema } from './dashboard.schemas.js';
import { DashboardService } from './dashboard.service.js';
import { handleError } from '../../utils/handleError.js';

export class DashboardController {
  static async analytics(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const query = analyticsQuerySchema.parse(req.query);
      const result = await DashboardService.analytics(req.userId, query);
      return res.json(analyticsResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async resumoMensal(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(resumoMensalResponseSchema.parse(await DashboardService.resumoMensal(req.userId, req.query.periodo)));
    } catch (error) { return handleError(res, 500, error); }
  }
  static async findGastosPorCategoria(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const result = await DashboardService.findGastosPorCategoria(req.userId, req.query.periodo);
      return res.json(gastosCategoriaResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findGastosPorFormaPagamento(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const result = await DashboardService.findGastosPorFormaPagamento(req.userId, req.query.periodo);
      return res.json(gastosFormaPagamentoResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findImpulsividade(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const result = await DashboardService.findImpulsividade(req.userId, req.query.periodo);
      return res.json(impulsividadeResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findComprasAcimaLimite(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const result = await DashboardService.findComprasAcimaLimite(req.userId, req.query.periodo);
      return res.json(limiteComprasResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findTempoVsGasto(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const result = await DashboardService.findTempoVsGasto(req.userId, req.query.periodo);
      return res.json(tempoVsGastoResponseSchema.parse(result));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }
}
