import { HomeService } from '../home/home.service.js';
import { HistoricoService } from './historico.service.js';
import { apresentarDescobertas } from './descobertas.resumo.js';
import { parseMonth } from '../compra/financeiro.js';
import { EventosResumoService } from '../compra/eventos.resumo.js';
import { AnaliseAutomaticaService } from './analise-automatica.service.js';

export class DescobertasService {
  static async consultar(userId: number, periodo: string) {
    parseMonth(periodo);
    const [financeiro, historico, eventos, automatico] =
      await Promise.allSettled([
        HomeService.consultar(userId, periodo),
        HistoricoService.consultar(userId, { periodo, mesesHistorico: 6 }),
        Promise.resolve().then(() =>
          EventosResumoService.consultar(userId, periodo),
        ),
        Promise.resolve().then(() =>
          AnaliseAutomaticaService.periodo(userId, periodo),
        ),
      ]);
    // O resumo agregado omite estabelecimentos, nomes e identificadores privados de compras e itens.
    return {
      versaoContrato: 1 as const,
      periodo,
      referenciaTemporal: 'America/Sao_Paulo' as const,
      financeiro: financeiro.status === 'fulfilled' ? financeiro.value : null,
      descobertas: [
        ...(automatico.status === 'fulfilled'
          ? automatico.value.descobertas.map((d) => ({
              id: d.id,
              tipo: 'REGISTRADO' as const,
              origem: 'ANALISE_COMPORTAMENTAL' as const,
              titulo: d.titulo,
              informacao: d.mensagem,
              evidencias: d.indicadores,
              periodo,
              relevancia: 0,
              compraId: null,
              acao: { destino: 'DASHBOARD' as const },
              limitacoes: automatico.value.limitacoes,
            }))
          : []),
        ...(historico.status === 'fulfilled'
          ? apresentarDescobertas(historico.value)
          : []),
      ].slice(0, 2),
      avaliacaoAutomatica:
        automatico.status === 'fulfilled' ? automatico.value : null,
      historico:
        historico.status === 'fulfilled'
          ? {
              frequencia: historico.value.frequencia.comparacao,
              planejamento: historico.value.planejamento,
              influenciaPromocional: historico.value.influenciaPromocional,
            }
          : null,
      eventos:
        eventos.status === 'fulfilled'
          ? eventos.value
          : { disponivel: false as const },
      indisponiveis: [
        ...(financeiro.status === 'rejected' ? ['FINANCEIRO'] : []),
        ...(historico.status === 'rejected' ? ['HISTORICO'] : []),
      ],
    };
  }
}
