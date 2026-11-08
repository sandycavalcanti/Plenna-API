import { handleError } from '../../utils/handleError.js';
import { ChatFirstMessageError, ChatService } from './chat.service.js';
import { createHistorySchema, createMessageSchema, historyIdSchema } from './chat.schemas.js';
export class ChatController {
    static async createHistory(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            createHistorySchema.parse(req.body ?? {});
            return res.status(201).json(await ChatService.createHistory(req.userId));
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async listHistories(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            return res.status(200).json(await ChatService.listHistories(req.userId));
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async deleteHistory(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token invalido' });
            const historyId = historyIdSchema.parse(req.params.historicoId);
            await ChatService.deleteHistory(req.userId, historyId);
            return res.status(204).send();
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async getHistory(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const historyId = historyIdSchema.parse(req.params.historicoId);
            return res.status(200).json(await ChatService.getHistory(req.userId, historyId));
        }
        catch (error) {
            return handleError(res, 404, error);
        }
    }
    static async createMessage(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token invalido' });
            const historyId = historyIdSchema.parse(req.params.historicoId);
            const input = createMessageSchema.parse(req.body);
            const result = await ChatService.sendMessage(req.userId, historyId, input);
            return res.status(200).json(result);
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async createFirstMessage(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token invalido' });
            const input = createMessageSchema.parse(req.body);
            return res.status(200).json(await ChatService.sendFirstMessage(req.userId, input));
        }
        catch (error) {
            if (error instanceof ChatFirstMessageError) {
                return res.status(error.statusCode).json({
                    message: error.message,
                    errors: [],
                    historico_id: error.historyId,
                });
            }
            return handleError(res, 500, error);
        }
    }
}
