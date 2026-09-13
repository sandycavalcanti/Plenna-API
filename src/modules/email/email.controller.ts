import type { Request, Response } from 'express';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { EmailService } from './email.service.js';
import { OAuthTentativaService } from './oauth-tentativa.service.js';
import { finalizarEmailSchema, stateSchema, tentativaSchema } from './email.schemas.js';
import { handleError } from '../../utils/handleError.js';
import { logSeguro } from '../../utils/logSeguro.js';

function semCache(res: Response) { res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' }); }
export class EmailController {
  static async connect(req: AuthRequest, res: Response) {
    semCache(res);
    if (!req.userId) return res.sendStatus(401);
    try { return res.json(await EmailService.iniciar(req.userId)); }
    catch (error) { logSeguro('oauth_falhou', error); return handleError(res, 500, error); }
  }
  static async callback(req: Request, res: Response) {
    semCache(res);
    try {
      const state = stateSchema.parse(req.query.state);
      const tentativa = await OAuthTentativaService.callback(state);
      const params = new URLSearchParams({ state, tentativa });
      if (req.query.error !== undefined) params.set('resultado', 'cancelado');
      else {
        if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) throw new Error('Callback invalido');
        params.set('code', req.query.code);
      }
      return res.redirect(303, 'plenna://oauth-success?' + params);
    } catch (error) {
      logSeguro('oauth_falhou', error);
      return res.redirect(303, 'plenna://oauth-success?resultado=erro');
    }
  }
  static async finalizar(req: AuthRequest, res: Response) {
    semCache(res);
    if (!req.userId) return res.sendStatus(401);
    try { return res.json(await EmailService.finalizar(req.userId, finalizarEmailSchema.parse(req.body))); }
    catch (error) { logSeguro('oauth_falhou', error); return handleError(res, 400, error); }
  }
  static async cancelar(req: AuthRequest, res: Response) {
    semCache(res);
    if (!req.userId) return res.sendStatus(401);
    try {
      await OAuthTentativaService.encerrar(req.userId, tentativaSchema.parse(req.body), 'CANCELADA');
      return res.sendStatus(204);
    } catch (error) { logSeguro('oauth_falhou', error); return handleError(res, 400, error); }
  }
  static async estado(req: AuthRequest, res: Response) {
    semCache(res);
    if (!req.userId) return res.sendStatus(401);
    try { return res.json(await EmailService.estado(req.userId)); }
    catch (error) { logSeguro('oauth_falhou', error); return handleError(res, 500, error); }
  }
}
