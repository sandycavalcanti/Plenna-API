import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CompraService } from '../compra/compra.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { analyticsQuerySchema, analyticsResponseSchema } from '../dashboard/dashboard.schemas.js';
import { GoalService } from '../goal/goal.service.js';
import { RecorrenciaService } from '../recorrencia/recorrencia.service.js';
import type { ToolDefinition } from './ai.contracts.js';

const dateOnly = z.string().datetime({ offset: true });
const month = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, 'Use o período AAAA-MM');
const boundedLimit = z.coerce.number().int().min(1).max(50).default(20);

const financeSummaryInputSchema = z.object({ periodo: month.optional() }).strict();
const financeSummaryResultSchema = z.object({
  periodo: z.string(), timezone: z.string(), inicio: z.string(), fimExclusivo: z.string(),
  totalConhecido: z.number().nonnegative(), total: z.number().nonnegative().nullable(),
  qualidade: z.enum(['COMPLETO', 'PARCIAL', 'INSUFICIENTE', 'SEM_COMPRAS']),
  comprasConfirmadas: z.number().int().nonnegative(), comprasComValor: z.number().int().nonnegative(), comprasSemValor: z.number().int().nonnegative(),
  mediaConhecida: z.number().nonnegative().nullable(), orcamentoMensal: z.number().positive().nullable(),
  estadoOrcamento: z.enum(['SEM_ORCAMENTO', 'EXCEDIDO', 'ATINGIDO', 'DENTRO', 'INDETERMINADO']),
  limitePorCompra: z.number().positive().nullable(), comprasAcimaLimiteIndividual: z.number().int().nonnegative().nullable(),
}).strict();

const purchaseListInputSchema = z.object({
  inicio: dateOnly.optional(),
  fim: dateOnly.optional(),
  limite: boundedLimit,
}).strict().superRefine((value, context) => {
  const inicio = value.inicio ? new Date(value.inicio) : undefined;
  const fim = value.fim ? new Date(value.fim) : undefined;
  if (inicio && fim && fim <= inicio) {
    context.addIssue({ code: 'custom', path: ['fim'], message: 'O fim deve ser posterior ao início.' });
  }
  if (inicio && fim && fim.getTime() - inicio.getTime() > 366 * 86_400_000) {
    context.addIssue({ code: 'custom', path: ['fim'], message: 'A janela máxima é de 366 dias.' });
  }
});

const purchaseItemSchema = z.object({
  id: z.number().int().positive(), nome: z.string(), valor: z.number().nonnegative(), quantidade: z.number().nonnegative().nullable(), categoria: z.string().nullable(),
}).strict();
const purchaseSchema = z.object({
  id: z.number().int().positive(), valor: z.number().nonnegative().nullable(), desconto: z.number().nonnegative(), horario: z.coerce.date(), fonte: z.string().nullable(), classificacao: z.string(),
  itens: z.array(purchaseItemSchema).max(100),
}).strict();
const purchaseListResultSchema = z.object({ itens: z.array(purchaseSchema).max(50), totalRetornado: z.number().int().nonnegative() }).strict();
const purchaseGetInputSchema = z.object({ compra_id: z.number().int().positive() }).strict();
const purchaseGetResultSchema = z.object({ compra: purchaseSchema }).strict();

const monthInputSchema = z.object({ periodo: month.optional() }).strict();
const categoryResultSchema = z.object({ categoria_nome: z.string(), total: z.number().nonnegative() }).strict();
const paymentResultSchema = z.object({ forma_pagamento_nome: z.string(), total: z.number().nonnegative() }).strict();
const impulsiveResultSchema = z.object({
  compra_classificacao: z.enum(['PENDENTE', 'IMPULSIVA', 'NAO_IMPULSIVA']), quantidade: z.number().int().nonnegative(), valor_total: z.number().nonnegative().nullable(), quantidade_total: z.number().int().nonnegative(), quantidade_sem_valor: z.number().int().nonnegative(),
}).strict();
const limitsResultSchema = z.object({
  periodo: z.string(), orcamentoMensal: z.number().positive().nullable(), estadoOrcamento: z.string(), limitePorCompra: z.number().positive().nullable(),
  comprasAcimaLimiteIndividual: z.number().int().nonnegative().nullable(), comprasAcimaLimite: z.number().int().nonnegative(), comprasDentroLimite: z.number().int().nonnegative(),
}).strict();

const goalsInputSchema = z.object({ limite: boundedLimit }).strict();
const goalResultSchema = z.object({ id: z.number().int().positive(), titulo: z.string(), descricao: z.string().nullable(), valor: z.number().nonnegative(), data: z.coerce.date().nullable(), completado: z.boolean() }).strict();

const recurrencesInputSchema = z.object({ status: z.enum(['ATIVA', 'PAUSADA', 'CANCELADA', 'FINALIZADA']).optional(), limite: boundedLimit }).strict();
const recurrenceItemSchema = z.object({ id: z.number().int().positive(), nome: z.string(), valor: z.number().nonnegative(), categoriaId: z.number().int().positive().nullable() }).strict();
const recurrenceSchema = z.object({
  id: z.number().int().positive(), status: z.string(), frequencia: z.string(), primeiraOcorrencia: z.string(), proximaOcorrencia: z.string().nullable(), dataFinal: z.string().nullable(), fusoHorario: z.string(), formaPagamento: z.object({ id: z.number().int().positive(), nome: z.string() }).nullable(), compraFonte: z.string().nullable(), itens: z.array(recurrenceItemSchema).max(100),
}).strict();
const recurrencesResultSchema = z.object({ itens: z.array(recurrenceSchema).max(50) }).strict();
const commitmentsInputSchema = z.object({ inicio: dateOnly, fim: dateOnly, limite: boundedLimit }).strict().superRefine((value, context) => {
  const inicio = new Date(value.inicio);
  const fim = new Date(value.fim);
  if (fim <= inicio) context.addIssue({ code: 'custom', path: ['fim'], message: 'O fim deve ser posterior ao início.' });
  if (fim.getTime() - inicio.getTime() > 366 * 86_400_000) context.addIssue({ code: 'custom', path: ['fim'], message: 'A janela máxima é de 366 dias.' });
});
const commitmentResultSchema = z.object({ inicio: z.coerce.date(), fim: z.coerce.date(), total: z.number().nonnegative(), ocorrencias: z.array(z.object({ recorrenciaId: z.number().int().positive(), dataPrevista: z.string(), valor: z.number().nonnegative() }).strict()).max(200) }).strict();

const usageResultSchema = z.object({ periodo: z.string(), itens: z.array(z.object({ app: z.string(), tempo_total: z.number().nonnegative(), gasto_total: z.number().nonnegative() }).strict()).max(50), autorizado: z.literal(true) }).strict();
const interactionInputSchema = z.object({ limite: z.coerce.number().int().min(1).max(20).default(10) }).strict();
const interactionResultSchema = z.object({ mensagens: z.array(z.object({ historico_id: z.number().int().positive(), remetente: z.enum(['user', 'assistant']), texto: z.string().max(2_000), data: z.coerce.date() }).strict()).max(20) }).strict();
const profileResultSchema = z.object({ nome: z.string(), limiteCompra: z.number().int().positive().nullable(), metaMensal: z.number().nonnegative().nullable(), metaPorCompra: z.number().nonnegative().nullable(), metaTempo: z.number().int().nonnegative().nullable() }).strict();
const consentResultSchema = z.object({ consentimentos: z.array(z.object({ codigo: z.string(), ativo: z.boolean() }).strict()).max(20) }).strict();

type PurchaseListArgs = { inicio?: Date; fim?: Date; limite: number };
type FinancialToolDependencies = {
  financeSummary: (userId: number, periodo?: string) => Promise<unknown>;
  listPurchases: (userId: number, args: PurchaseListArgs) => Promise<unknown>;
  getPurchase: (userId: number, id: number) => Promise<unknown>;
  spendingByCategory: (userId: number, periodo?: string) => Promise<unknown>;
  spendingByPayment: (userId: number, periodo?: string) => Promise<unknown>;
  impulsivity: (userId: number, periodo?: string) => Promise<unknown>;
  analytics: (userId: number, args: z.infer<typeof analyticsQuerySchema>) => Promise<unknown>;
  limits: (userId: number, periodo?: string) => Promise<unknown>;
  goals: (userId: number) => Promise<any[]>;
  recurrences: (userId: number, status?: string) => Promise<any[]>;
  upcoming: (userId: number, id: number, limit: number) => Promise<any>;
  usage: (userId: number, periodo?: string) => Promise<unknown>;
  interactions: (userId: number, limite: number) => Promise<unknown>;
  profile: (userId: number) => Promise<unknown>;
  consents: (userId: number) => Promise<unknown>;
};

function serializePurchase(row: any) {
  return {
    id: row.compra_id,
    valor: row.compra_valor === null ? null : Number(row.compra_valor),
    desconto: Number(row.compra_desconto ?? 0),
    horario: row.compra_horario,
    fonte: row.compra_fonte ?? null,
    classificacao: String(row.compra_classificacao),
    itens: (row.tb_compra_item ?? []).map((item: any) => ({
      id: item.compra_item_id,
      nome: item.compra_item_nome,
      valor: Number(item.compra_item_valor),
      quantidade: item.compra_item_quantidade === null || item.compra_item_quantidade === undefined ? null : Number(item.compra_item_quantidade),
      categoria: item.tb_categoria?.categoria_nome ?? null,
    })),
  };
}

function serializeGoal(row: any) {
  return { id: row.meta_id, titulo: row.meta_titulo, descricao: row.meta_descricao ?? null, valor: Number(row.meta_valor), data: row.meta_data ?? null, completado: Boolean(row.meta_completado) };
}

function serializeRecurrence(row: any) {
  return {
    id: row.id, status: row.status, frequencia: row.frequencia, primeiraOcorrencia: row.primeiraOcorrencia, proximaOcorrencia: row.proximaOcorrencia ?? null, dataFinal: row.dataFinal ?? null, fusoHorario: row.fusoHorario,
    formaPagamento: row.formaPagamento ? { id: row.formaPagamento.id, nome: row.formaPagamento.nome } : null,
    compraFonte: row.compraFonte ?? null,
    itens: (row.itens ?? []).map((item: any) => ({ id: item.id, nome: item.nome, valor: Number(item.valor), categoriaId: item.categoriaId ?? null })),
  };
}

function normalizePurchaseListArgs(input: z.infer<typeof purchaseListInputSchema>): PurchaseListArgs {
  return {
    limite: input.limite,
    ...(input.inicio ? { inicio: new Date(input.inicio) } : {}),
    ...(input.fim ? { fim: new Date(input.fim) } : {}),
  };
}

function normalizeCommitmentArgs(input: z.infer<typeof commitmentsInputSchema>) {
  return { ...input, inicio: new Date(input.inicio), fim: new Date(input.fim) };
}

function defaultDependencies(): FinancialToolDependencies {
  return {
    financeSummary: (userId, periodo) => DashboardService.resumoMensal(userId, periodo),
    listPurchases: async (userId, args) => {
      const rows = await prisma.tb_compra.findMany({
        where: {
          usuario_id: userId, compra_ativo: 1, compra_status: 'CONFIRMADA',
          ...(args.inicio || args.fim ? { compra_horario: { ...(args.inicio ? { gte: args.inicio } : {}), ...(args.fim ? { lt: args.fim } : {}) } } : {}),
        },
        select: {
          compra_id: true, compra_valor: true, compra_desconto: true, compra_horario: true, compra_fonte: true, compra_classificacao: true,
          tb_compra_item: { where: { compra_item_ativo: 1 }, select: { compra_item_id: true, compra_item_nome: true, compra_item_valor: true, compra_item_quantidade: true, tb_categoria: { select: { categoria_nome: true } } } },
        },
        orderBy: [{ compra_horario: 'desc' }, { compra_id: 'desc' }], take: args.limite,
      });
      return { itens: rows.map(serializePurchase), totalRetornado: rows.length };
    },
    getPurchase: async (userId, id) => ({ compra: serializePurchase(await CompraService.findById(userId, id)) }),
    spendingByCategory: (userId, periodo) => DashboardService.findGastosPorCategoria(userId, periodo),
    spendingByPayment: (userId, periodo) => DashboardService.findGastosPorFormaPagamento(userId, periodo),
    impulsivity: (userId, periodo) => DashboardService.findImpulsividade(userId, periodo),
    analytics: (userId, args) => DashboardService.analytics(userId, args),
    limits: async (userId, periodo) => {
      const [summary, limits] = await Promise.all([DashboardService.resumoMensal(userId, periodo), DashboardService.findComprasAcimaLimite(userId, periodo)]);
      return { periodo: summary.periodo, orcamentoMensal: summary.orcamentoMensal, estadoOrcamento: summary.estadoOrcamento, limitePorCompra: summary.limitePorCompra, comprasAcimaLimiteIndividual: summary.comprasAcimaLimiteIndividual, comprasAcimaLimite: limits.acima_limite, comprasDentroLimite: limits.dentro_limite };
    },
    goals: (userId) => GoalService.findAllByUserId(userId),
    recurrences: (userId, status) => RecorrenciaService.findAll(userId, status as any),
    upcoming: (userId, id, limit) => RecorrenciaService.upcoming(userId, id, limit),
    usage: async (userId, periodo) => {
      const authorized = await ConsentimentoService.temConsentimentoAtivo(userId, CONSENTIMENTO_CODIGOS.MONITORAMENTO_TEMPO_USO);
      if (!authorized) throw new AppError('O monitoramento de tempo de uso não está autorizado.', 403);
      return { periodo: periodo ?? new Date().toISOString().slice(0, 7), itens: await DashboardService.findTempoVsGasto(userId, periodo), autorizado: true };
    },
    interactions: async (userId, limite) => {
      const rows = await prisma.tb_mensagem.findMany({
        where: { tb_historico: { usuario_id: userId } },
        select: { historico_id: true, mensagem_remetente: true, mensagem_texto: true, mensagem_data_criacao: true },
        orderBy: [{ mensagem_data_criacao: 'desc' }, { mensagem_id: 'desc' }], take: limite,
      });
      return { mensagens: [...rows].reverse().map((row) => ({ historico_id: row.historico_id, remetente: row.mensagem_remetente ? 'assistant' : 'user', texto: row.mensagem_texto.slice(0, 2_000), data: row.mensagem_data_criacao })) };
    },
    profile: async (userId) => {
      const row = await prisma.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true }, select: { usuario_nome: true, usuario_limite_compra: true, usuario_meta_valor_mensal: true, usuario_meta_valor_compra: true, usuario_meta_tempo: true } });
      if (!row) throw new AppError('Usuário não encontrado.', 404);
      return { nome: row.usuario_nome, limiteCompra: row.usuario_limite_compra, metaMensal: row.usuario_meta_valor_mensal === null ? null : Number(row.usuario_meta_valor_mensal), metaPorCompra: row.usuario_meta_valor_compra === null ? null : Number(row.usuario_meta_valor_compra), metaTempo: row.usuario_meta_tempo };
    },
    consents: async (userId) => ({ consentimentos: (await ConsentimentoService.findAllByUserId(userId)).map((row: any) => ({ codigo: row.tb_consentimento_tipo.consentimento_tipo_codigo, ativo: Boolean(row.consentimento_status) })) }),
  };
}

export function createFinancialToolDefinitions(dependencies: FinancialToolDependencies = defaultDependencies()): ToolDefinition<any, any>[] {
  return [
    { name: 'profile_get', description: 'Consulta apenas o perfil financeiro seguro do usuário autenticado.', argsSchema: z.object({}).strict(), resultSchema: profileResultSchema, execute: (_args, context) => dependencies.profile(context.usuario_id) },
    { name: 'finance_summary', description: 'Consulta o resumo financeiro mensal real do usuário autenticado.', argsSchema: financeSummaryInputSchema, resultSchema: financeSummaryResultSchema, execute: (args, context) => dependencies.financeSummary(context.usuario_id, args.periodo) },
    { name: 'purchase_list', description: 'Lista compras confirmadas do usuário com filtros de período.', argsSchema: purchaseListInputSchema, resultSchema: purchaseListResultSchema, execute: (args, context) => dependencies.listPurchases(context.usuario_id, normalizePurchaseListArgs(args)) },
    { name: 'purchase_get', description: 'Consulta uma compra própria e seus itens ativos.', argsSchema: purchaseGetInputSchema, resultSchema: purchaseGetResultSchema, execute: (args, context) => dependencies.getPurchase(context.usuario_id, args.compra_id) },
    { name: 'spending_by_category', description: 'Consulta gastos reais agrupados por categoria.', argsSchema: monthInputSchema, resultSchema: z.array(categoryResultSchema).max(100), execute: (args, context) => dependencies.spendingByCategory(context.usuario_id, args.periodo) },
    { name: 'spending_by_payment', description: 'Consulta gastos reais agrupados por forma de pagamento.', argsSchema: monthInputSchema, resultSchema: z.array(paymentResultSchema).max(100), execute: (args, context) => dependencies.spendingByPayment(context.usuario_id, args.periodo) },
    { name: 'impulsive_purchase_summary', description: 'Consulta a classificação observada das compras, sem diagnóstico comportamental.', argsSchema: monthInputSchema, resultSchema: z.array(impulsiveResultSchema).max(10), execute: (args, context) => dependencies.impulsivity(context.usuario_id, args.periodo) },
    { name: 'finance_analytics', description: 'Consulta análises financeiras determinísticas por mês, evolução ou comparação.', argsSchema: analyticsQuerySchema, resultSchema: analyticsResponseSchema, execute: (args, context) => dependencies.analytics(context.usuario_id, args) },
    { name: 'limits_status', description: 'Consulta orçamento, limite por compra e contagens observadas.', argsSchema: monthInputSchema, resultSchema: limitsResultSchema, execute: (args, context) => dependencies.limits(context.usuario_id, args.periodo) },
    { name: 'goals_list', description: 'Lista metas financeiras declaradas pelo usuário autenticado.', argsSchema: goalsInputSchema, resultSchema: z.object({ itens: z.array(goalResultSchema).max(50) }).strict(), execute: async (args, context) => ({ itens: (await dependencies.goals(context.usuario_id)).slice(0, args.limite).map(serializeGoal) }) },
    { name: 'recurrences_list', description: 'Lista compromissos recorrentes próprios e seus valores.', argsSchema: recurrencesInputSchema, resultSchema: recurrencesResultSchema, execute: async (args, context) => ({ itens: (await dependencies.recurrences(context.usuario_id, args.status)).slice(0, args.limite).map(serializeRecurrence) }) },
    { name: 'recurrence_commitments', description: 'Calcula compromissos recorrentes previstos em uma janela limitada.', argsSchema: commitmentsInputSchema, resultSchema: commitmentResultSchema, execute: async (rawArgs, context) => {
      const args = normalizeCommitmentArgs(rawArgs);
      const rows = await dependencies.recurrences(context.usuario_id, 'ATIVA');
      const ocorrencias: Array<{ recorrenciaId: number; dataPrevista: string; valor: number }> = [];
      for (const row of (rows as any[]).slice(0, args.limite)) {
        const upcoming = await dependencies.upcoming(context.usuario_id, row.id, 50) as any;
        const valor = (row.itens ?? []).reduce((sum: number, item: any) => sum + Number(item.valor ?? 0), 0);
        for (const occurrence of upcoming.ocorrencias ?? []) {
          const timestamp = new Date(`${occurrence.dataPrevista}T00:00:00.000Z`).getTime();
          if (timestamp >= args.inicio.getTime() && timestamp < args.fim.getTime()) ocorrencias.push({ recorrenciaId: row.id, dataPrevista: occurrence.dataPrevista, valor });
        }
      }
      return { inicio: args.inicio, fim: args.fim, total: ocorrencias.reduce((sum, item) => sum + item.valor, 0), ocorrencias: ocorrencias.slice(0, 200) };
    } },
    { name: 'usage_summary', description: 'Consulta tempo de uso somente com consentimento específico ativo.', argsSchema: monthInputSchema, resultSchema: usageResultSchema, execute: (args, context) => dependencies.usage(context.usuario_id, args.periodo) },
    { name: 'interaction_recent', description: 'Consulta poucas mensagens recentes do histórico próprio para contexto.', argsSchema: interactionInputSchema, resultSchema: interactionResultSchema, execute: (args, context) => dependencies.interactions(context.usuario_id, args.limite) },
    { name: 'consent_status', description: 'Consulta os consentimentos do usuário sem alterá-los.', argsSchema: z.object({}).strict(), resultSchema: consentResultSchema, execute: (_args, context) => dependencies.consents(context.usuario_id) },
  ];
}

export type { FinancialToolDependencies };
