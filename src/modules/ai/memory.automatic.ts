import { z } from 'zod';
import { env } from '../../lib/env.js';
import type { AIProvider } from '../email/ai-provider.js';
import {
  MEMORY_ORIGINS,
  memoryContentSchema,
  memoryEvidenceSchema,
  memoryIdSchema,
  memoryAutomaticCandidateInputSchema,
  memoryOriginSchema,
  MemoryPolicyError,
} from './memory.contracts.js';
import type { MemoryAuthorizationContext } from './memory.contracts.js';
import type { MemoryAutomaticCandidateInput } from './memory.contracts.js';
import { MemoryService, MemoryServiceError } from './memory.service.js';

const automaticMemoryDecisionSchema = z
  .object({
    salvar: z.boolean(),
    conteudo: memoryContentSchema.optional(),
    origem: memoryOriginSchema.optional(),
    evidencia: memoryEvidenceSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.salvar) return;
    if (!value.conteudo) {
      context.addIssue({ code: 'custom', path: ['conteudo'], message: 'Uma memória elegível precisa de conteúdo.' });
    }
    if (!value.origem) {
      context.addIssue({ code: 'custom', path: ['origem'], message: 'Uma memória elegível precisa de origem.' });
    }
    if (value.origem === MEMORY_ORIGINS.INFERIDA && !value.evidencia) {
      context.addIssue({ code: 'custom', path: ['evidencia'], message: 'Memórias inferidas exigem evidência.' });
    }
  });

export type AutomaticMemoryDecision = z.infer<typeof automaticMemoryDecisionSchema>;

export type AutomaticMemoryProvider = Pick<AIProvider, 'chat'>;

export type AutomaticMemorySettings = {
  enabled?: boolean;
  maxContextChars?: number;
  timeoutMs?: number;
};

export type AutomaticMemoryInvalidResponseReason = 'JSON_INVALIDO' | 'SCHEMA_INVALIDO';

export type AutomaticMemoryResult =
  | { status: 'DESABILITADA' | 'CONSENTIMENTO_INATIVO' | 'OPTOUT' | 'EXPLICITA_DELEGADA' | 'SEM_CANDIDATO' | 'PROVIDER_INDISPONIVEL' | 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' }
  | { status: 'RESPOSTA_INVALIDA'; motivo: AutomaticMemoryInvalidResponseReason }
  | { status: 'SALVA' | 'DUPLICADA'; memoria: Awaited<ReturnType<MemoryService['save']>>['memoria'] }
  | { status: 'IGNORADA' | 'FALHA'; motivo: 'CONTEUDO_INVALIDO' | 'CONTEUDO_SENSIVEL' | 'PERSISTENCIA' | 'DUPLICATA_INDISPONIVEL' | 'PROVIDER' | 'TIMEOUT' };

export type AutomaticMemoryAuthorizationResolver = (
  usuarioId: number,
) => Promise<MemoryAuthorizationContext>;

const sensitiveMemoryInputPattern = /\b(?:senha|password|token|secret|segredo|credential|credencial|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|bearer|cookie|private[ _-]?key)\b|\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/i;

function normalizeForIntent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Opt-out explícito bloqueia tanto o caminho automático quanto o explícito. */
export function hasMemoryWriteOptOut(text: string): boolean {
  const normalized = normalizeForIntent(text);
  if (!normalized) return false;

  return /\b(?:nao|nunca|jamais)\b[^.?!]{0,80}\b(?:memorize|memorizar|guarde|guardar|salve|salvar|registre|registrar|anote|anotar)\b/.test(normalized)
    || /\bnao\s+(?:quero|preciso|gostaria)\b[^.?!]{0,80}\b(?:memoria|guardar|salvar|registrar|anotar|memorizar)\b/.test(normalized);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AUTOMATIC_MEMORY_TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type ParsedAutomaticMemoryDecision =
  | { decision: AutomaticMemoryDecision }
  | { motivo: AutomaticMemoryInvalidResponseReason };

function parseDecision(raw: string): ParsedAutomaticMemoryDecision {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { motivo: 'JSON_INVALIDO' };
  }

  const parsed = automaticMemoryDecisionSchema.safeParse(json);
  return parsed.success ? { decision: parsed.data } : { motivo: 'SCHEMA_INVALIDO' };
}

type AutomaticMemoryLogValue = boolean | number | string;

function logAutomaticMemory(
  evento: string,
  details: Record<string, AutomaticMemoryLogValue> = {},
): void {
  // Os eventos são deliberadamente poucos e nunca carregam mensagem, evidência,
  // prompt, resposta do provider, identificadores de usuário ou dados financeiros.
  if (env.isProduction && evento !== 'final' && evento !== 'falha_integracao') return;
  console.info('ai_memory_automatica', { evento, ...details });
}

function groundingTokens(text: string): string[] {
  return normalizeForIntent(text).match(/[\p{L}\p{N}]{4,}/gu) ?? [];
}

const portugueseNumberWords = new Set([
  'zero', 'um', 'uma', 'dois', 'duas', 'tres', 'quatro', 'cinco', 'seis',
  'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze',
  'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
  'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta',
  'oitenta', 'noventa', 'cem',
]);

function numericTokens(text: string): string[] {
  const normalized = normalizeForIntent(text);
  const digits = normalized.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
  const words = (normalized.match(/[\p{L}]+/gu) ?? [])
    .filter((word) => portugueseNumberWords.has(word));
  return [...digits, ...words];
}

/**
 * A tool recebe uma decisão do mesmo modelo que está respondendo o chat, mas
 * a persistência só é aceita quando a evidência mantém ligação observável com
 * a mensagem atual. Isso é uma barreira conservadora, não uma prova semântica
 * completa de segurança.
 */
function isGroundedCandidate(message: string, candidate: MemoryAutomaticCandidateInput): boolean {
  const normalizedMessage = normalizeForIntent(message);
  const normalizedContent = normalizeForIntent(candidate.conteudo);
  if (!normalizedMessage || normalizedContent === normalizedMessage) return false;

  const sourceTokens = new Set(groundingTokens(message));
  const evidenceTokens = new Set(groundingTokens(candidate.evidencia));
  const overlap = [...evidenceTokens].filter((token) => sourceTokens.has(token)).length;
  const minimumOverlap = sourceTokens.size <= 6 ? 1 : 2;
  if (overlap < minimumOverlap) return false;

  const sourceNumbers = new Set(numericTokens(message));
  return numericTokens(`${candidate.conteudo} ${candidate.evidencia}`)
    .every((number) => sourceNumbers.has(number));
}

export class AutomaticMemoryService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly resolveAuthorization: AutomaticMemoryAuthorizationResolver,
    private readonly settings: AutomaticMemorySettings = {},
  ) {}

  /**
   * Persiste um candidato produzido pela rodada principal do chatbot. Não
   * chama provider: a decisão de relevância já veio como tool call da rodada
   * principal e o backend ainda revalida consentimento, evidência e conteúdo.
   */
  async saveCandidate(input: {
    usuario_id: number;
    historico_id: number;
    mensagem: string;
    candidato: unknown;
    explicitWriteIntent?: boolean;
  }): Promise<AutomaticMemoryResult> {
    const startedAt = Date.now();
    const enabled = this.settings.enabled ?? env.aiMemoryAutomaticEnabled;
    let consentimento: 'NAO_AVALIADO' | 'ATIVO' | 'INATIVO' = 'NAO_AVALIADO';
    const finish = (result: AutomaticMemoryResult): AutomaticMemoryResult => {
      const details: Record<string, AutomaticMemoryLogValue> = {
        fluxo: 'RODADA_PRINCIPAL',
        resultado: result.status,
        duracaoMs: Date.now() - startedAt,
        habilitada: enabled,
        consentimento,
        tentativaExterna: false,
      };
      if ('motivo' in result) details.motivo = result.motivo;
      logAutomaticMemory('final', details);
      return result;
    };

    logAutomaticMemory('inicio', {
      fluxo: 'RODADA_PRINCIPAL',
      habilitada: enabled,
      providerSelecionado: env.aiProvider,
      // A ferramenta só é exposta quando a rodada possui chatWithTools.
      providerDisponivel: true,
    });

    if (!memoryIdSchema.safeParse(input.usuario_id).success || !memoryIdSchema.safeParse(input.historico_id).success) {
      return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_INVALIDO' });
    }
    if (hasMemoryWriteOptOut(input.mensagem)) return finish({ status: 'OPTOUT' });
    if (input.explicitWriteIntent) return finish({ status: 'EXPLICITA_DELEGADA' });
    if (sensitiveMemoryInputPattern.test(input.mensagem)) {
      return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' });
    }
    if (!enabled) return finish({ status: 'DESABILITADA' });

    const parsedCandidate = memoryAutomaticCandidateInputSchema.safeParse(input.candidato);
    if (!parsedCandidate.success || !isGroundedCandidate(input.mensagem, parsedCandidate.data)) {
      return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_INVALIDO' });
    }

    let authorization: MemoryAuthorizationContext;
    try {
      authorization = await this.resolveAuthorization(input.usuario_id);
    } catch {
      consentimento = 'INATIVO';
      return finish({ status: 'CONSENTIMENTO_INATIVO' });
    }
    if (!authorization.consentimento_memoria_ativo || !authorization.pode_escrever) {
      consentimento = 'INATIVO';
      return finish({ status: 'CONSENTIMENTO_INATIVO' });
    }
    consentimento = 'ATIVO';

    try {
      const result = await this.memoryService.saveAutomatic(
        { ...authorization, pode_escrever_automaticamente: true },
        { ...parsedCandidate.data, historico_id: input.historico_id },
      );
      return finish(result.deduplicada
        ? { status: 'DUPLICADA', memoria: result.memoria }
        : { status: 'SALVA', memoria: result.memoria });
    } catch (error) {
      if (error instanceof MemoryPolicyError && error.code === 'MEMORY_SENSITIVE_CONTENT') {
        return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' });
      }
      if (error instanceof MemoryPolicyError || error instanceof MemoryServiceError) {
        if (error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED') {
          return finish({ status: 'IGNORADA', motivo: 'DUPLICATA_INDISPONIVEL' });
        }
        if (error instanceof MemoryServiceError && error.code === 'MEMORY_PERSISTENCE_FAILED') {
          return finish({ status: 'FALHA', motivo: 'PERSISTENCIA' });
        }
        return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_INVALIDO' });
      }
      return finish({ status: 'FALHA', motivo: 'PERSISTENCIA' });
    }
  }

  async consider(input: {
    usuario_id: number;
    historico_id: number;
    mensagem: string;
    provider?: AutomaticMemoryProvider;
    explicitWriteIntent?: boolean;
  }): Promise<AutomaticMemoryResult> {
    const startedAt = Date.now();
    const enabled = this.settings.enabled ?? env.aiMemoryAutomaticEnabled;
    let consentimento: 'NAO_AVALIADO' | 'ATIVO' | 'INATIVO' = 'NAO_AVALIADO';
    let tentativaExterna = false;
    const finish = (result: AutomaticMemoryResult): AutomaticMemoryResult => {
      const details: Record<string, AutomaticMemoryLogValue> = {
        resultado: result.status,
        duracaoMs: Date.now() - startedAt,
        habilitada: enabled,
        providerSelecionado: env.aiProvider,
        providerDisponivel: Boolean(input.provider),
        consentimento,
        tentativaExterna,
      };
      if ('motivo' in result) details.motivo = result.motivo;
      logAutomaticMemory('final', details);
      return result;
    };

    logAutomaticMemory('inicio', {
      habilitada: enabled,
      providerSelecionado: env.aiProvider,
      providerDisponivel: Boolean(input.provider),
    });

    if (!memoryIdSchema.safeParse(input.usuario_id).success || !memoryIdSchema.safeParse(input.historico_id).success) {
      return finish({ status: 'FALHA', motivo: 'CONTEUDO_INVALIDO' });
    }

    if (hasMemoryWriteOptOut(input.mensagem)) return finish({ status: 'OPTOUT' });
    if (input.explicitWriteIntent) return finish({ status: 'EXPLICITA_DELEGADA' });
    if (sensitiveMemoryInputPattern.test(input.mensagem)) {
      return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' });
    }

    if (!enabled) return finish({ status: 'DESABILITADA' });

    let authorization: MemoryAuthorizationContext;
    try {
      authorization = await this.resolveAuthorization(input.usuario_id);
    } catch {
      consentimento = 'INATIVO';
      logAutomaticMemory('consentimento', { autorizado: false, motivo: 'AUTORIZACAO_INDISPONIVEL' });
      return finish({ status: 'CONSENTIMENTO_INATIVO' });
    }
    if (!authorization.consentimento_memoria_ativo || !authorization.pode_escrever) {
      consentimento = 'INATIVO';
      logAutomaticMemory('consentimento', { autorizado: false, motivo: 'CONSENTIMENTO_INATIVO' });
      return finish({ status: 'CONSENTIMENTO_INATIVO' });
    }
    consentimento = 'ATIVO';
    logAutomaticMemory('consentimento', { autorizado: true });
    if (!input.provider) return finish({ status: 'PROVIDER_INDISPONIVEL' });

    const message = input.mensagem.trim().slice(0, this.settings.maxContextChars ?? env.aiMemoryAutomaticMaxContextChars);
    if (!message) return finish({ status: 'SEM_CANDIDATO' });

    let parsedDecision: ParsedAutomaticMemoryDecision;
    const timeoutMs = this.settings.timeoutMs ?? env.aiMemoryAutomaticTimeoutMs;
    tentativaExterna = true;
    logAutomaticMemory('tentativa_externa', { timeoutMs });
    try {
      const raw = await withTimeout(input.provider.chat([
        {
          role: 'system',
          content: [
            'Avalie se a mensagem do usuário contém uma informação duradoura e útil para futuras conversas financeiras.',
            'Responda somente JSON no formato {"salvar":boolean,"conteudo":string,"origem":"DECLARADA"|"INFERIDA","evidencia":string|null}.',
            'Use salvar:false para cumprimentos, comentários passageiros, compras isoladas, dados temporários ou quando não houver evidência suficiente.',
            'Informação diretamente declarada pelo usuário usa DECLARADA; uma conclusão derivada usa INFERIDA e exige uma evidência curta da mensagem.',
            'Não faça diagnósticos, não presuma sentimentos, não salve credenciais e não copie a mensagem inteira.',
          ].join(' '),
        },
        { role: 'user', content: message },
      ]), timeoutMs);
      parsedDecision = parseDecision(raw);
    } catch (error) {
      const motivo = error instanceof Error && error.message === 'AUTOMATIC_MEMORY_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER';
      logAutomaticMemory('analise', { resultado: 'FALHA', motivo });
      return finish({ status: 'FALHA', motivo });
    }

    if ('motivo' in parsedDecision) {
      logAutomaticMemory('analise', { resultado: 'RESPOSTA_INVALIDA', motivo: parsedDecision.motivo });
      return finish({ status: 'RESPOSTA_INVALIDA', motivo: parsedDecision.motivo });
    }

    const decision = parsedDecision.decision;
    logAutomaticMemory('analise', { resultado: decision.salvar ? 'CANDIDATO' : 'SEM_CANDIDATO' });
    if (!decision.salvar) return finish({ status: 'SEM_CANDIDATO' });

    // A autorização é reconsultada depois da análise. O modelo não controla
    // consentimento, usuário, histórico ou a modalidade de escrita.
    let currentAuthorization: MemoryAuthorizationContext;
    try {
      currentAuthorization = await this.resolveAuthorization(input.usuario_id);
    } catch {
      consentimento = 'INATIVO';
      logAutomaticMemory('consentimento', { autorizado: false, motivo: 'REVOGADO_DURANTE_ANALISE' });
      return finish({ status: 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' });
    }
    if (!currentAuthorization.consentimento_memoria_ativo || !currentAuthorization.pode_escrever) {
      consentimento = 'INATIVO';
      logAutomaticMemory('consentimento', { autorizado: false, motivo: 'REVOGADO_DURANTE_ANALISE' });
      return finish({ status: 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' });
    }

    try {
      const result = await this.memoryService.saveAutomatic(
        { ...currentAuthorization, pode_escrever_automaticamente: true },
        {
          conteudo: decision.conteudo,
          origem: decision.origem,
          evidencia: decision.evidencia ?? undefined,
          historico_id: input.historico_id,
        },
      );
      return finish(result.deduplicada
        ? { status: 'DUPLICADA', memoria: result.memoria }
        : { status: 'SALVA', memoria: result.memoria });
    } catch (error) {
      if (error instanceof MemoryPolicyError && error.code === 'MEMORY_SENSITIVE_CONTENT') {
        return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' });
      }
      if (error instanceof MemoryPolicyError || error instanceof MemoryServiceError) {
        if (error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED') {
          return finish({ status: 'IGNORADA', motivo: 'DUPLICATA_INDISPONIVEL' });
        }
        if (error instanceof MemoryServiceError && error.code === 'MEMORY_PERSISTENCE_FAILED') {
          logAutomaticMemory('analise', { resultado: 'FALHA', motivo: 'PERSISTENCIA' });
          return finish({ status: 'FALHA', motivo: 'PERSISTENCIA' });
        }
        return finish({ status: 'IGNORADA', motivo: 'CONTEUDO_INVALIDO' });
      }
      logAutomaticMemory('analise', { resultado: 'FALHA', motivo: 'PERSISTENCIA' });
      return finish({ status: 'FALHA', motivo: 'PERSISTENCIA' });
    }
  }
}
