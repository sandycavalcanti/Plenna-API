import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../auth/auth.middleware.js';
import { RF018Service } from './rf018.service.js';
import { HistoricoService } from './historico.service.js';
import { DescobertasService } from './descobertas.service.js';
import { AutomaticoService } from './automatico.service.js';
import { handleError } from '../../utils/handleError.js';
export const analisesRouter = Router();
const querySchema = z.object({ periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict();
analisesRouter.get('/compras/:compraId/automatica',authMiddleware,async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{const {compraId}=z.object({compraId:z.coerce.number().int().positive()}).parse(req.params);z.object({}).strict().parse(req.query);
  return res.json(await AutomaticoService.compra((req as import('../auth/auth.middleware.js').AuthRequest).userId!,compraId));
 }catch(error){return handleError(res,500,error);}
});
analisesRouter.get('/descobertas', authMiddleware, async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{const {periodo}=querySchema.parse(req.query);return res.json(await DescobertasService.consultar((req as import('../auth/auth.middleware.js').AuthRequest).userId!,periodo));}
  catch(error){return handleError(res,500,error);}
});
analisesRouter.get('/historico', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(await HistoricoService.consultar((req as import('../auth/auth.middleware.js').AuthRequest).userId!, req.query));
  } catch (error) { return handleError(res, 500, error); }
});
analisesRouter.get('/comportamento', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { periodo } = querySchema.parse(req.query);
    const userId = (req as import('../auth/auth.middleware.js').AuthRequest).userId!;
    return res.json(await RF018Service.consultar(userId, periodo));
  } catch (error) { return handleError(res, 500, error); }
});
