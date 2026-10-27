import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { AppError } from '../../errors/AppError.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
import { parseMonth } from '../compra/financeiro.js';
import { AnaliseComportamentalService } from '../analise/comportamento.service.js';
import { recomendar, type RecommendationContext } from './recomendacao.engine.js';
import { RecommendationTextService, type RecommendationTextProvider } from './recomendacao.text.js';
import { proactiveCandidateSchema, type ProactiveCandidate } from '../proatividade/proatividade.contracts.js';

export const recommendationStatusSchema = z.enum(['NOVA', 'VISUALIZADA', 'DESCARTADA']);
export const recommendationQuerySchema = z.object({
  limite: z.coerce.number().int().min(1).max(20).default(10),
  cursor: z.coerce.number().int().positive().optional(),
}).strict();
export const recommendationStatusInputSchema = z.object({ status: z.enum(['VISUALIZADA', 'DESCARTADA']) }).strict();

export type RecommendationRecord = {
  ai_recomendacao_id: number;
  usuario_id: number;
  ai_recomendacao_tipo: string;
  ai_recomendacao_titulo: string;
  ai_recomendacao_texto: string;
  ai_recomendacao_evidencias: Prisma.InputJsonValue;
  ai_recomendacao_chave: string;
  ai_recomendacao_status: string;
  ai_recomendacao_historico_id: number | null;
  ai_recomendacao_data_expiracao: Date | null;
  ai_recomendacao_data_criacao: Date;
};

export type RecommendationRepository = {
  list(userId: number, options: { limit: number; cursor?: number; now: Date }): Promise<RecommendationRecord[]>;
  findById(userId: number, id: number): Promise<RecommendationRecord | null>;
  findByKey(userId: number, key: string): Promise<RecommendationRecord | null>;
  create(data: Omit<RecommendationRecord, 'ai_recomendacao_id'>): Promise<RecommendationRecord>;
  updateStatus(userId: number, id: number, status: 'VISUALIZADA' | 'DESCARTADA'): Promise<boolean>;
};

const recommendationSelect = {
  ai_recomendacao_id: true, usuario_id: true, ai_recomendacao_tipo: true, ai_recomendacao_titulo: true,
  ai_recomendacao_texto: true, ai_recomendacao_evidencias: true, ai_recomendacao_chave: true,
  ai_recomendacao_status: true, ai_recomendacao_historico_id: true, ai_recomendacao_data_expiracao: true,
  ai_recomendacao_data_criacao: true,
} as const;

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaRecommendationRepository implements RecommendationRepository {
  private readonly db: Pick<PrismaClient, 'tb_ai_recomendacao'>;

  constructor(db: Pick<PrismaClient, 'tb_ai_recomendacao'> = prisma) {
    this.db = db;
  }

  list(userId: number, options: { limit: number; cursor?: number; now: Date }) {
    return this.db.tb_ai_recomendacao.findMany({
      where: {
        usuario_id: userId,
        ai_recomendacao_status: { not: 'DESCARTADA' },
        OR: [{ ai_recomendacao_data_expiracao: null }, { ai_recomendacao_data_expiracao: { gt: options.now } }],
        ...(options.cursor ? { ai_recomendacao_id: { lt: options.cursor } } : {}),
      },
      orderBy: { ai_recomendacao_id: 'desc' },
      take: options.limit,
      select: recommendationSelect,
    }) as Promise<RecommendationRecord[]>;
  }

  findById(userId: number, id: number) {
    return this.db.tb_ai_recomendacao.findFirst({ where: { usuario_id: userId, ai_recomendacao_id: id }, select: recommendationSelect }) as Promise<RecommendationRecord | null>;
  }

  findByKey(userId: number, key: string) {
    return this.db.tb_ai_recomendacao.findFirst({ where: { usuario_id: userId, ai_recomendacao_chave: key }, select: recommendationSelect }) as Promise<RecommendationRecord | null>;
  }

  create(data: Omit<RecommendationRecord, 'ai_recomendacao_id'>) {
    return this.db.tb_ai_recomendacao.create({ data: data as Prisma.tb_ai_recomendacaoUncheckedCreateInput, select: recommendationSelect }) as Promise<RecommendationRecord>;
  }

  async updateStatus(userId: number, id: number, status: 'VISUALIZADA' | 'DESCARTADA') {
    const result = await this.db.tb_ai_recomendacao.updateMany({ where: { usuario_id: userId, ai_recomendacao_id: id }, data: { ai_recomendacao_status: status } });
    return result.count === 1;
  }
}

export function recommendationDedupeKey(periodo: string, codigo: string, referencias: string[]) {
  return createHash('sha256').update(`recomendacao:v1|periodo:${periodo}|regra:${codigo}|evento:${[...referencias].sort().join(',')}`).digest('hex');
}

function serialize(record: RecommendationRecord) {
  return {
    id: record.ai_recomendacao_id,
    tipo: record.ai_recomendacao_tipo,
    titulo: record.ai_recomendacao_titulo,
    texto: record.ai_recomendacao_texto,
    evidencias: record.ai_recomendacao_evidencias,
    status: record.ai_recomendacao_status,
    expiraEm: record.ai_recomendacao_data_expiracao,
    criadaEm: record.ai_recomendacao_data_criacao,
  };
}

function nextMonth(periodo: string) {
  const { start } = parseMonth(periodo);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

function validateGenerationInput(userId: number, periodo: string) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new AppError('Usuário inválido', 400);
  parseMonth(periodo);
}

async function defaultAnalysis(userId: number, periodo: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    const snapshot = await AnaliseComportamentalService.consultarSnapshot(tx, userId, periodo, now);
    const { start, end } = parseMonth(periodo);
    const [impulsive, impulsiveValue, metas, recurrences] = await Promise.all([
      tx.tb_compra.count({ where: { usuario_id: userId, compra_ativo: 1, compra_status: 'CONFIRMADA', compra_classificacao: 'IMPULSIVA', compra_horario: { gte: start, lt: end } } }),
      tx.tb_compra.aggregate({ where: { usuario_id: userId, compra_ativo: 1, compra_status: 'CONFIRMADA', compra_classificacao: 'IMPULSIVA', compra_horario: { gte: start, lt: end } }, _sum: { compra_valor: true } }),
      tx.tb_meta.findMany({ where: { usuario_id: userId }, select: { meta_id: true, meta_titulo: true, meta_valor: true, meta_completado: true, meta_data: true }, orderBy: { meta_data_criacao: 'desc' }, take: 10 }),
      tx.tb_compra_recorrencia.findMany({ where: { usuario_id: userId, compra_recorrencia_status: 'ATIVA' }, select: { compra_recorrencia_id: true, compra_recorrencia_frequencia: true, compra_recorrencia_proxima_ocorrencia: true, tb_compra_item: { where: { compra_id: null, compra_item_ativo: 1 }, select: { compra_item_valor: true, compra_item_quantidade: true } } }, take: 20 }),
    ]);
    const context: RecommendationContext = {
      comprasImpulsivas: { quantidade: impulsive, valorConhecido: impulsiveValue._sum.compra_valor === null ? null : Number(impulsiveValue._sum.compra_valor) },
      metas: metas.map((goal) => ({ id: goal.meta_id, titulo: goal.meta_titulo, valor: Number(goal.meta_valor), concluida: goal.meta_completado, data: goal.meta_data })),
      recorrencias: recurrences.map((row) => {
        const total = row.tb_compra_item.reduce((sum, item) => sum + Number(item.compra_item_valor) * Number(item.compra_item_quantidade ?? 1), 0);
        const factor = row.compra_recorrencia_frequencia === 'DIARIA' ? 30 : row.compra_recorrencia_frequencia === 'SEMANAL' ? 4.3 : row.compra_recorrencia_frequencia === 'ANUAL' ? 1 / 12 : 1;
        return { id: row.compra_recorrencia_id, proximaOcorrencia: row.compra_recorrencia_proxima_ocorrencia?.toISOString() ?? null, valorMensalConhecido: total * factor };
      }),
      enableExpandedRules: true,
    };
    return { analise: snapshot.analise, context };
  });
}

export class RecommendationService {
  private readonly repository: RecommendationRepository;
  private readonly textService: RecommendationTextService;
  private readonly consent: typeof ConsentimentoService;
  private readonly analysis: (userId: number, periodo: string, now: Date) => Promise<{ analise: unknown; context: RecommendationContext }>;

  constructor(
    repository: RecommendationRepository = new PrismaRecommendationRepository(),
    textService = new RecommendationTextService(),
    consent = ConsentimentoService,
    analysis: (userId: number, periodo: string, now: Date) => Promise<{ analise: unknown; context: RecommendationContext }> = defaultAnalysis,
  ) {
    this.repository = repository;
    this.textService = textService;
    this.consent = consent;
    this.analysis = analysis;
  }

  private async requireConsent(userId: number) {
    if (!(await this.consent.temConsentimentoAtivo(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO))) {
      throw new AppError('Consentimento de personalização não está ativo', 403);
    }
  }

  async list(userId: number, query: z.infer<typeof recommendationQuerySchema>, now = new Date()) {
    const active = await this.consent.temConsentimentoAtivo(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO);
    if (!active) return { itens: [], proximoCursor: null, consentimentoAtivo: false };
    const records = await this.repository.list(userId, { limit: query.limite, cursor: query.cursor, now });
    return { itens: records.map(serialize), proximoCursor: records.length === query.limite ? records[records.length - 1]!.ai_recomendacao_id : null, consentimentoAtivo: true };
  }

  /** Fonte única de candidatos persistidos para a futura execução proativa. */
  async listEligibleForProactivity(userId: number, limit: number, now = new Date()): Promise<ProactiveCandidate[]> {
    await this.requireConsent(userId);
    const records = await this.repository.list(userId, { limit, now });
    const candidates: ProactiveCandidate[] = [];
    for (const record of records) {
      if (record.ai_recomendacao_historico_id !== null) continue;
      const parsed = proactiveCandidateSchema.safeParse({
        id: record.ai_recomendacao_id,
        chave: record.ai_recomendacao_chave,
        tipo: record.ai_recomendacao_tipo,
        titulo: record.ai_recomendacao_titulo,
        texto: record.ai_recomendacao_texto,
        evidencias: record.ai_recomendacao_evidencias,
        recomendacaoHistoricoId: record.ai_recomendacao_historico_id,
        expiraEm: record.ai_recomendacao_data_expiracao,
      });
      if (parsed.success) candidates.push(parsed.data);
    }
    return candidates;
  }

  async get(userId: number, id: number) {
    await this.requireConsent(userId);
    const record = await this.repository.findById(userId, id);
    if (!record || record.ai_recomendacao_status === 'DESCARTADA' || (record.ai_recomendacao_data_expiracao && record.ai_recomendacao_data_expiracao <= new Date())) throw new AppError('Recomendação não encontrada', 404);
    return serialize(record);
  }

  async updateStatus(userId: number, id: number, status: 'VISUALIZADA' | 'DESCARTADA') {
    const existing = await this.repository.findById(userId, id);
    if (!existing) throw new AppError('Recomendação não encontrada', 404);
    if (existing.ai_recomendacao_status === 'DESCARTADA' && status === 'VISUALIZADA') {
      throw new AppError('Recomendação descartada não pode ser reativada', 409);
    }
    if (!(await this.repository.updateStatus(userId, id, status))) throw new AppError('Recomendação não encontrada', 404);
    return { id, status };
  }

  async conversation(userId: number, id: number) {
    const record = await this.get(userId, id);
    return { recomendacaoId: record.id, contexto: `Quero conversar sobre a recomendação "${record.titulo}". ${record.texto}`.slice(0, 800) };
  }

  async generateForUser(userId: number, periodo: string, now = new Date(), provider?: RecommendationTextProvider, options: { persist?: boolean } = {}) {
    validateGenerationInput(userId, periodo);
    await this.requireConsent(userId);
    const { analise, context } = await this.analysis(userId, periodo, now);
    const result = recomendar(analise, { ...context, maxCandidates: context.maxCandidates ?? env.recommendationMaxCandidates });
    const expiration = nextMonth(periodo);
    const persisted = [];
    const preview = [];
    const textService = provider ? new RecommendationTextService(provider) : this.textService;
    for (const candidate of result.recomendacoes) {
      const text = await textService.generate(candidate);
      const key = recommendationDedupeKey(periodo, candidate.codigo, candidate.referencias);
      const data = {
        usuario_id: userId, ai_recomendacao_tipo: candidate.codigo, ai_recomendacao_titulo: text.titulo, ai_recomendacao_texto: text.texto,
        ai_recomendacao_evidencias: { versao: 1, fonte: text.fonte, periodo, referencias: candidate.referencias, limitacoes: candidate.limitacoes } as Prisma.InputJsonValue,
        ai_recomendacao_chave: key, ai_recomendacao_status: 'NOVA', ai_recomendacao_historico_id: null,
        ai_recomendacao_data_expiracao: expiration, ai_recomendacao_data_criacao: now,
      } satisfies Omit<RecommendationRecord, 'ai_recomendacao_id'>;
      if (options.persist === false) {
        preview.push({
          id: null,
          tipo: data.ai_recomendacao_tipo,
          titulo: data.ai_recomendacao_titulo,
          texto: data.ai_recomendacao_texto,
          evidencias: data.ai_recomendacao_evidencias,
          status: 'PREVIA',
          expiraEm: data.ai_recomendacao_data_expiracao,
          criadaEm: data.ai_recomendacao_data_criacao,
        });
        continue;
      }
      await this.requireConsent(userId);
      try {
        persisted.push(await this.repository.create(data));
      } catch (error) {
        if (!isUniqueError(error)) throw new AppError('Não foi possível persistir a recomendação', 500);
        const existing = await this.repository.findByKey(userId, key);
        if (existing && existing.ai_recomendacao_status !== 'DESCARTADA' && (!existing.ai_recomendacao_data_expiracao || existing.ai_recomendacao_data_expiracao > now)) persisted.push(existing);
        else continue;
      }
    }
    return { estado: result.estado, itens: options.persist === false ? preview : persisted.map(serialize) };
  }

  async previewForUser(userId: number, periodo: string, now = new Date(), provider?: RecommendationTextProvider) {
    if (env.isProduction) throw new AppError('Pré-visualização indisponível neste ambiente', 403);
    return this.generateForUser(userId, periodo, now, provider, { persist: false });
  }
}

export const recommendationService = new RecommendationService();

export type ManualRecommendationOptions = {
  preview?: boolean;
  now?: Date;
  provider?: RecommendationTextProvider;
};

/** Internal development/test entry point. It is deliberately not exposed as an HTTP route. */
export async function runRecommendationManually(userId: number, periodo: string, options: ManualRecommendationOptions = {}) {
  if (env.isProduction) throw new AppError('Execução manual indisponível neste ambiente', 403);
  const now = options.now ?? new Date();
  return options.preview === false
    ? recommendationService.generateForUser(userId, periodo, now, options.provider)
    : recommendationService.previewForUser(userId, periodo, now, options.provider);
}
