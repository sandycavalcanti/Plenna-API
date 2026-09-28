// Função para ser usada nos blocos catch dos controllers, para evitar repetição de código e centralizar a lógica de tratamento de erros.
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';
export function handleError(res, status, err) {
    if (err instanceof ZodError) {
        return res.status(400).json({
            message: 'Dados inválidos',
            errors: err.issues.map((issue) => ({
                field: issue.path[0],
                message: issue.message,
            })),
        });
    }
    if (err instanceof AppError) {
        const statusCode = err.statusCode || status || 400;
        return res.status(statusCode).json({
            message: err.message,
            errors: [],
        });
    }
    return res.status(500).json({
        message: 'Erro interno do servidor',
        errors: [],
    });
}
