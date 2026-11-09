import { HomeService } from '../home/home.service.js';
import { HistoricoService } from './historico.service.js';
import { apresentarDescobertas } from './descobertas.resumo.js';
import { parseMonth } from '../compra/financeiro.js';
import { EventosResumoService } from '../compra/eventos.resumo.js';
import { AnaliseAutomaticaService } from './analise-automatica.service.js';
export class DescobertasService {
    static async consultar(userId, periodo, now = new Date()) {
        parseMonth(periodo);
        const [financeiro, historico, eventos, automatico] = await Promise.allSettled([
            HomeService.consultar(userId, periodo, now),
            HistoricoService.consultar(userId, { periodo, mesesHistorico: 6 }, now),
            Promise.resolve().then(() => EventosResumoService.consultar(userId, periodo, now)),
            Promise.resolve().then(() => AnaliseAutomaticaService.periodo(userId, periodo, now)),
        ]);
        // O resumo agregado omite estabelecimentos, nomes e identificadores privados de compras e itens.
        return {
            versaoContrato: 1,
            periodo,
            referenciaTemporal: 'America/Sao_Paulo',
            financeiro: financeiro.status === 'fulfilled' ? financeiro.value : null,
            descobertas: [
                ...(automatico.status === 'fulfilled'
                    ? automatico.value.descobertas.map((d) => ({
                        id: d.id,
                        tipo: 'REGISTRADO',
                        origem: 'ANALISE_COMPORTAMENTAL',
                        titulo: d.titulo,
                        informacao: d.mensagem,
                        evidencias: d.indicadores,
                        periodo,
                        relevancia: 0,
                        compraId: null,
                        acao: { destino: 'DASHBOARD' },
                        limitacoes: automatico.value.limitacoes,
                    }))
                    : []),
                ...(historico.status === 'fulfilled'
                    ? apresentarDescobertas(historico.value)
                    : []),
            ].slice(0, 2),
            avaliacaoAutomatica: automatico.status === 'fulfilled' ? automatico.value : null,
            historico: historico.status === 'fulfilled'
                ? {
                    frequencia: historico.value.frequencia.comparacao,
                    planejamento: historico.value.planejamento,
                    influenciaPromocional: historico.value.influenciaPromocional,
                }
                : null,
            eventos: eventos.status === 'fulfilled'
                ? eventos.value
                : { disponivel: false },
            indisponiveis: [
                ...(financeiro.status === 'rejected' ? ['FINANCEIRO'] : []),
                ...(historico.status === 'rejected' ? ['HISTORICO'] : []),
            ],
        };
    }
}
