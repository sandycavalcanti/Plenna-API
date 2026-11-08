import { AppError } from '../../errors/AppError.js';
import { businessDateKey } from './financeiro.js';
// Validate navigation independently from the policy for retroactively imported purchases.
export function validarPeriodoConta(query, criacao, now = new Date()) {
    if (!Number.isFinite(criacao?.getTime()) || criacao > now)
        throw new AppError('Não foi possível determinar o período da conta', 409);
    const minimo = businessDateKey(criacao), maximo = businessDateKey(now);
    if (query.mes && (query.mes < minimo.slice(0, 7) || query.mes > maximo.slice(0, 7)))
        throw new AppError('Escolha um mês entre a criação da conta e o mês atual', 400);
    if (query.inicio && (query.inicio < minimo || query.inicio > maximo) ||
        query.fim && (query.fim < minimo || query.fim > maximo) ||
        query.inicio && query.fim && query.inicio > query.fim)
        throw new AppError('Escolha datas entre a criação da conta e hoje, com início até o fim', 400);
    return { minimo, maximo };
}
