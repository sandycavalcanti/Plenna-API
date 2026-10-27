import { env } from '../../lib/env.js';
import { createAIProvider } from '../email/ai-provider.factory.js';
import type { AIProvider } from '../email/ai-provider.js';
import { proactiveFactsSchema, proactiveTextSchema, type ProactiveFacts, type ProactiveText } from './proatividade.contracts.js';

export type ProactiveTextProvider = {
  chat(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string>;
};

export type ProactiveTextSettings = {
  enabled?: boolean;
  maxAttempts?: number;
  maxContextChars?: number;
  timeoutMs?: number;
  fallbackReason?: ProactiveFallbackReason;
};

export type ProactiveFallbackReason =
  | 'FLAGS_DESABILITADAS'
  | 'PROVIDER_NAO_CONFIGURADO'
  | 'PROVIDER_CONSTRUCAO_FALHOU'
  | 'PROVIDER_ERRO'
  | 'TIMEOUT'
  | 'JSON_INVALIDO'
  | 'SCHEMA_INVALIDO'
  | 'SAIDA_NAO_FUNDAMENTADA'
  | 'AFIRMACAO_NAO_AUTORIZADA'
  | 'NUMERO_NAO_EVIDENCIADO';

const FORBIDDEN_WORDS = new Set([
  'senha', 'senhas', 'token', 'tokens', 'credencial', 'credenciais', 'oauth', 'segredo', 'segredos', 'api', 'chave',
  'ansiedade', 'ansioso', 'ansiosa', 'depressao', 'depressivo', 'diagnostico', 'culpa', 'culpado', 'culpada',
  'viciado', 'viciada', 'certeza', 'causou', 'causa', 'sempre', 'nunca', 'obrigatorio',
]);

const DIRECTIONAL_STEMS = [
  'acim', 'abaix', 'aument', 'cai', 'cresc', 'diminu', 'dentro', 'elev', 'exced', 'fora',
  'frequ', 'impuls', 'mais', 'melhor', 'menor', 'neg', 'nao', 'menos', 'pior', 'reduz',
  'sem', 'subi', 'super', 'queda',
];

const FACTUAL_STEMS = [
  ...DIRECTIONAL_STEMS,
  'ating', 'abert', 'fech', 'categori', 'comprom', 'compr', 'econom', 'gast', 'limit',
  'meta', 'media', 'poup', 'progress', 'recorr', 'saldo', 'total', 'valor', 'quant',
];

const FORBIDDEN_STEMS = [
  'ansied', 'caus', 'culp', 'depress', 'diagnost', 'emoc', 'garant', 'obrig', 'prova',
  'signific', 'vici',
];

function words(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? [];
}

function hasDirectionalStem(value: string) {
  return DIRECTIONAL_STEMS.some((stem) => value.startsWith(stem));
}

function sharesDirectionalStem(left: string, right: string) {
  return DIRECTIONAL_STEMS.some((stem) => left.startsWith(stem) && right.startsWith(stem));
}

function sharesFactualStem(left: string, right: string) {
  return FACTUAL_STEMS.some((stem) => left.startsWith(stem) && right.startsWith(stem));
}

function hasForbiddenStem(value: string) {
  return FORBIDDEN_WORDS.has(value) || FORBIDDEN_STEMS.some((stem) => value.startsWith(stem));
}

function logRedaction(event: string, details: Record<string, unknown> = {}) {
  console.info('ai_proactivity_redacao', {
    evento: event,
    provider: env.aiProvider,
    iaHabilitada: env.proactivityAiEnabled,
    externoAprovado: env.proactivityExternalApproved,
    ...details,
  });
}

function errorReason(error: unknown): ProactiveFallbackReason {
  if (error instanceof Error && error.message === 'PROACTIVE_TEXT_TIMEOUT') return 'TIMEOUT';
  return 'PROVIDER_ERRO';
}

function deterministic(facts: ProactiveFacts, fonte: ProactiveText['fonte'] = 'DETERMINISTICA'): ProactiveText {
  const guidance: string = {
    ACOMPANHAR_ORCAMENTO_EXCEDIDO: 'Vale olhar as despesas recentes e pensar em onde economizar nas próximas compras. Quer analisar isso comigo?',
    REVISAR_LIMITE_INDIVIDUAL: 'Que tal analisarmos esses gastos e pensarmos em maneiras de evitar novos excessos? Pequenas decisões podem ajudar a manter seu planejamento.',
    ATENCAO_META: 'Que tal vermos como os próximos gastos podem se encaixar melhor no seu planejamento para ajudar você a avançar?',
    REVISAR_COMPRAS_IMPULSIVAS: 'Uma pausa antes das próximas compras pode ajudar você a revisar prioridades e decidir com mais calma.',
  }[facts.tipo] ?? 'Se quiser, podemos conversar sobre próximos passos a partir desses dados.';
  const text = `${facts.texto} ${guidance}`;
  return { ...proactiveTextSchema.parse({ titulo: facts.titulo, texto: text.slice(0, 600) }), fonte };
}

function groundedOutput(raw: string, facts: ProactiveFacts): { output: ProactiveText | null; reason?: ProactiveFallbackReason } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { output: null, reason: 'JSON_INVALIDO' }; }
  const result = proactiveTextSchema.safeParse(parsed);
  if (!result.success) return { output: null, reason: 'SCHEMA_INVALIDO' };

  const sourceText = [facts.titulo, facts.texto, facts.periodo ?? '', ...facts.referencias, ...facts.limitacoes].join(' ');
  const sourceWords = words(sourceText);
  const source = new Set(sourceWords);
  const outputWords = words(`${result.data.titulo} ${result.data.texto}`);
  const numericSource = sourceWords.filter((word) => /^\d/.test(word));
  const outputNumbers = outputWords.filter((word) => /^\d/.test(word));
  const contentSource = new Set([...source].filter((word) => /[a-z]/.test(word) && word.length > 3));
  const grounded = outputWords.filter((word) => contentSource.has(word));

  // Números precisam aparecer na mesma ordem e em um trecho contíguo dos
  // fatos. Isso impede combinar valores de evidências distintas para formar
  // uma afirmação nova.
  if (outputNumbers.length > 0) {
    let sourceIndex = 0;
    for (const number of outputNumbers) {
      const foundAt = numericSource.indexOf(number, sourceIndex);
      if (foundAt < 0) return { output: null, reason: 'NUMERO_NAO_EVIDENCIADO' };
      sourceIndex = foundAt + 1;
    }
  }

  for (const word of outputWords) {
    if (hasForbiddenStem(word)) return { output: null, reason: 'AFIRMACAO_NAO_AUTORIZADA' };
    if (/^\d/.test(word)) continue;
    if (!/^[a-z]+$/.test(word)) return { output: null, reason: 'SCHEMA_INVALIDO' };
    if (hasDirectionalStem(word) && !sourceWords.some((sourceWord) => sharesDirectionalStem(word, sourceWord))) {
      return { output: null, reason: 'AFIRMACAO_NAO_AUTORIZADA' };
    }
    if (FACTUAL_STEMS.some((stem) => word.startsWith(stem))
      && !sourceWords.some((sourceWord) => sharesFactualStem(word, sourceWord))) {
      return { output: null, reason: 'AFIRMACAO_NAO_AUTORIZADA' };
    }
  }
  if (grounded.length === 0) return { output: null, reason: 'SAIDA_NAO_FUNDAMENTADA' };
  return { output: { ...result.data, fonte: 'IA' } };
}

export function createApprovedProactiveMessageService(
  providerFactory: () => AIProvider | null = createAIProvider,
) {
  // O provider externo só é construído com aprovação explícita. O default é
  // determinístico e não realiza chamadas de rede.
  if (!env.proactivityAiEnabled || !env.proactivityExternalApproved) {
    logRedaction('provider_desabilitado', { fonte: 'DETERMINISTICA', motivo: 'FLAGS_DESABILITADAS' });
    return new ProactiveMessageService(undefined, { fallbackReason: 'FLAGS_DESABILITADAS' });
  }

  try {
    const provider = providerFactory();
    if (!provider) {
      logRedaction('provider_nao_configurado', {
        fonte: 'DETERMINISTICA',
        motivo: 'PROVIDER_NAO_CONFIGURADO',
        providerConfigurado: false,
      });
      return new ProactiveMessageService(undefined, { fallbackReason: 'PROVIDER_NAO_CONFIGURADO' });
    }
    logRedaction('provider_pronto', { providerConfigurado: true });
    return new ProactiveMessageService({
      chat: (messages) => provider.chat(messages.map((message) => ({ role: message.role, content: message.content }))),
    }, { enabled: true });
  } catch (error) {
    logRedaction('provider_construcao_falhou', {
      fonte: 'DETERMINISTICA',
      motivo: 'PROVIDER_CONSTRUCAO_FALHOU',
      tipo: error instanceof Error ? error.name.slice(0, 80) : 'ERRO_DESCONHECIDO',
    });
    return new ProactiveMessageService(undefined, { fallbackReason: 'PROVIDER_CONSTRUCAO_FALHOU' });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PROACTIVE_TEXT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export class ProactiveMessageService {
  private readonly provider?: ProactiveTextProvider;
  private readonly settings: ProactiveTextSettings;

  constructor(provider?: ProactiveTextProvider, settings: ProactiveTextSettings = {}) {
    this.provider = provider;
    this.settings = settings;
  }

  async generate(rawFacts: ProactiveFacts): Promise<ProactiveText> {
    const facts = proactiveFactsSchema.parse(rawFacts);
    const fallback = deterministic(facts);
    const aiEnabled = this.settings.enabled ?? env.proactivityAiEnabled;
    if (!aiEnabled || !this.provider) {
      logRedaction('redacao_finalizada', {
        fonte: 'DETERMINISTICA',
        motivo: this.settings.fallbackReason ?? (aiEnabled ? 'PROVIDER_NAO_CONFIGURADO' : 'FLAGS_DESABILITADAS'),
      });
      return fallback;
    }

    const limitedFacts = JSON.stringify({
      tipo: facts.tipo,
      titulo: facts.titulo,
      texto: facts.texto,
      periodo: facts.periodo,
      referencias: facts.referencias,
      limitacoes: facts.limitacoes,
    }).slice(0, this.settings.maxContextChars ?? env.proactivityMaxContextChars);

    const maxAttempts = Math.max(1, Math.min(this.settings.maxAttempts ?? env.proactivityMaxAttempts, 3));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logRedaction('tentativa_externa', { iaHabilitada: aiEnabled, tentativa: attempt, maxTentativas: maxAttempts });
      try {
      const raw = await withTimeout(this.provider.chat([
        { role: 'system', content: 'Redija uma mensagem proativa curta, acolhedora e preventiva em português brasileiro. Ofereça uma orientação prática de consumo consciente e convide o usuário a conversar. Responda somente JSON com titulo e texto. Reescreva apenas os fatos fornecidos; não invente números, causas, emoções, diagnósticos ou dados pessoais. Não sugira alterar ou aumentar limites como solução automática.' },
        { role: 'user', content: limitedFacts },
      ]), this.settings.timeoutMs ?? env.proactivityTimeoutMs);
      const validation = groundedOutput(raw, facts);
      if (validation.output) {
        logRedaction('redacao_finalizada', { iaHabilitada: aiEnabled, fonte: 'IA', validacao: 'ACEITA', tentativa: attempt });
        return validation.output;
      }
      logRedaction('redacao_finalizada', {
        iaHabilitada: aiEnabled,
        fonte: 'DETERMINISTICA_FALLBACK',
        validacao: 'REJEITADA',
        motivo: validation.reason ?? 'SAIDA_NAO_FUNDAMENTADA',
        tentativa: attempt,
      });
      return deterministic(facts, 'DETERMINISTICA_FALLBACK');
      } catch (error) {
        const motivo = errorReason(error);
        logRedaction('tentativa_externa_falhou', { iaHabilitada: aiEnabled, motivo, tentativa: attempt, maxTentativas: maxAttempts });
        if (attempt === maxAttempts) {
          logRedaction('redacao_finalizada', { iaHabilitada: aiEnabled, fonte: 'DETERMINISTICA_FALLBACK', motivo });
          return deterministic(facts, 'DETERMINISTICA_FALLBACK');
        }
      }
    }
    logRedaction('redacao_finalizada', { iaHabilitada: aiEnabled, fonte: 'DETERMINISTICA_FALLBACK', motivo: 'PROVIDER_ERRO' });
    return deterministic(facts, 'DETERMINISTICA_FALLBACK');
  }
}

