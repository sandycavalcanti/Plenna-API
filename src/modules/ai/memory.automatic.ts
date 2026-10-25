import { z } from 'zod';
import { env } from '../../lib/env.js';
import type { AIProvider } from '../email/ai-provider.js';
import {
  MEMORY_ORIGINS,
  memoryContentSchema,
  memoryEvidenceSchema,
  memoryIdSchema,
  memoryOriginSchema,
  MemoryPolicyError,
} from './memory.contracts.js';
import type { MemoryAuthorizationContext } from './memory.contracts.js';
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

export type AutomaticMemoryResult =
  | { status: 'DESABILITADA' | 'CONSENTIMENTO_INATIVO' | 'OPTOUT' | 'EXPLICITA_DELEGADA' | 'SEM_CANDIDATO' | 'RESPOSTA_INVALIDA' | 'PROVIDER_INDISPONIVEL' | 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' }
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

function parseDecision(raw: string): AutomaticMemoryDecision | null {
  try {
    const parsed = automaticMemoryDecisionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AutomaticMemoryService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly resolveAuthorization: AutomaticMemoryAuthorizationResolver,
    private readonly settings: AutomaticMemorySettings = {},
  ) {}

  async consider(input: {
    usuario_id: number;
    historico_id: number;
    mensagem: string;
    provider?: AutomaticMemoryProvider;
    explicitWriteIntent?: boolean;
  }): Promise<AutomaticMemoryResult> {
    if (!memoryIdSchema.safeParse(input.usuario_id).success || !memoryIdSchema.safeParse(input.historico_id).success) {
      return { status: 'FALHA', motivo: 'CONTEUDO_INVALIDO' };
    }

    if (hasMemoryWriteOptOut(input.mensagem)) return { status: 'OPTOUT' };
    if (input.explicitWriteIntent) return { status: 'EXPLICITA_DELEGADA' };
    if (sensitiveMemoryInputPattern.test(input.mensagem)) {
      return { status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' };
    }

    const enabled = this.settings.enabled ?? env.aiMemoryAutomaticEnabled;
    if (!enabled) return { status: 'DESABILITADA' };

    let authorization: MemoryAuthorizationContext;
    try {
      authorization = await this.resolveAuthorization(input.usuario_id);
    } catch {
      return { status: 'CONSENTIMENTO_INATIVO' };
    }
    if (!authorization.consentimento_memoria_ativo || !authorization.pode_escrever) {
      return { status: 'CONSENTIMENTO_INATIVO' };
    }
    if (!input.provider) return { status: 'PROVIDER_INDISPONIVEL' };

    const message = input.mensagem.trim().slice(0, this.settings.maxContextChars ?? env.aiMemoryAutomaticMaxContextChars);
    if (!message) return { status: 'SEM_CANDIDATO' };

    let decision: AutomaticMemoryDecision | null;
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
      ]), this.settings.timeoutMs ?? env.aiMemoryAutomaticTimeoutMs);
      decision = parseDecision(raw);
    } catch (error) {
      return { status: 'FALHA', motivo: error instanceof Error && error.message === 'AUTOMATIC_MEMORY_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER' };
    }

    if (!decision) return { status: 'RESPOSTA_INVALIDA' };
    if (!decision.salvar) return { status: 'SEM_CANDIDATO' };

    // A autorização é reconsultada depois da análise. O modelo não controla
    // consentimento, usuário, histórico ou a modalidade de escrita.
    let currentAuthorization: MemoryAuthorizationContext;
    try {
      currentAuthorization = await this.resolveAuthorization(input.usuario_id);
    } catch {
      return { status: 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' };
    }
    if (!currentAuthorization.consentimento_memoria_ativo || !currentAuthorization.pode_escrever) {
      return { status: 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE' };
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
      return result.deduplicada
        ? { status: 'DUPLICADA', memoria: result.memoria }
        : { status: 'SALVA', memoria: result.memoria };
    } catch (error) {
      if (error instanceof MemoryPolicyError && error.code === 'MEMORY_SENSITIVE_CONTENT') {
        return { status: 'IGNORADA', motivo: 'CONTEUDO_SENSIVEL' };
      }
      if (error instanceof MemoryPolicyError || error instanceof MemoryServiceError) {
        if (error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED') {
          return { status: 'IGNORADA', motivo: 'DUPLICATA_INDISPONIVEL' };
        }
        return { status: 'IGNORADA', motivo: 'CONTEUDO_INVALIDO' };
      }
      return { status: 'FALHA', motivo: 'PERSISTENCIA' };
    }
  }
}
