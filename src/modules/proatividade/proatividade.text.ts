import { env } from '../../lib/env.js';
import { proactiveFactsSchema, proactiveTextSchema, type ProactiveFacts, type ProactiveText } from './proatividade.contracts.js';

export type ProactiveTextProvider = {
  chat(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string>;
};

export type ProactiveTextSettings = {
  enabled?: boolean;
  maxAttempts?: number;
  maxContextChars?: number;
  timeoutMs?: number;
};

const SAFE_GENERIC_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'considere', 'confira', 'de', 'do', 'dos', 'e', 'em', 'esta', 'este',
  'fato', 'foi', 'ha', 'isso', 'mais', 'na', 'nas', 'no', 'nos', 'observar', 'o', 'os', 'para', 'pode', 'por',
  'que', 'se', 'seu', 'seus', 'sua', 'suas', 'sobre', 'tambem', 'um', 'uma', 'voce', 'vale', 'verifique', 'com',
  'base', 'dados', 'registrados', 'registro', 'periodo', 'momento', 'proximo', 'proxima', 'ajudar', 'acompanhar',
  'acompanhe', 'organizar', 'planejamento', 'planeje', 'revisar', 'revise', 'atencao', 'mensagem', 'plenna',
  'identificado', 'identificada', 'indica', 'indicam', 'pode', 'ser', 'uma', 'forma', 'de', 'manter', 'seu',
  'controle', 'caso', 'quando', 'sinta', 'necessidade', 'lembrar', 'compartilhar', 'observacao', 'observacao',
  'financeira', 'financeiro', 'informacao', 'informacoes', 'conhecido', 'conhecida', 'registrada', 'registrado',
]);

const FORBIDDEN_WORDS = new Set([
  'senha', 'senhas', 'token', 'tokens', 'credencial', 'credenciais', 'oauth', 'segredo', 'segredos', 'api', 'chave',
  'ansiedade', 'ansioso', 'ansiosa', 'depressao', 'depressivo', 'diagnostico', 'culpa', 'culpado', 'culpada',
  'viciado', 'viciada', 'certeza', 'causou', 'causa', 'sempre', 'nunca', 'obrigatorio',
]);

function words(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? [];
}

function deterministic(facts: ProactiveFacts, fonte: ProactiveText['fonte'] = 'DETERMINISTICA'): ProactiveText {
  const text = `Quero compartilhar uma observação baseada em dados registrados: ${facts.titulo}. ${facts.texto}`;
  return { ...proactiveTextSchema.parse({ titulo: facts.titulo, texto: text.slice(0, 600) }), fonte };
}

function groundedOutput(raw: string, facts: ProactiveFacts): ProactiveText | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const result = proactiveTextSchema.safeParse(parsed);
  if (!result.success) return null;

  const source = new Set(words([facts.titulo, facts.texto, ...facts.referencias, ...facts.limitacoes].join(' ')));
  const outputWords = words(`${result.data.titulo} ${result.data.texto}`);
  const numericSource = new Set([...source].filter((word) => /^\d/.test(word)));
  const contentSource = new Set([...source].filter((word) => /[a-z]/.test(word) && word.length > 3));
  const grounded = outputWords.filter((word) => contentSource.has(word));

  for (const word of outputWords) {
    if (FORBIDDEN_WORDS.has(word)) return null;
    if (/^\d/.test(word) && !numericSource.has(word)) return null;
    if (!/^[a-z]+$/.test(word) && !/^\d/.test(word)) return null;
    if (!source.has(word) && !SAFE_GENERIC_WORDS.has(word)) return null;
  }
  if (grounded.length === 0) return null;
  return { ...result.data, fonte: 'IA' };
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
    if (!(this.settings.enabled ?? env.proactivityAiEnabled) || !this.provider) return fallback;

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
      try {
      const raw = await withTimeout(this.provider.chat([
        { role: 'system', content: 'Redija uma mensagem proativa curta em português brasileiro. Responda somente JSON com titulo e texto. Reescreva apenas os fatos fornecidos; não invente números, causas, emoções, diagnósticos ou dados pessoais.' },
        { role: 'user', content: limitedFacts },
      ]), this.settings.timeoutMs ?? env.proactivityTimeoutMs);
      return groundedOutput(raw, facts) ?? deterministic(facts, 'DETERMINISTICA_FALLBACK');
      } catch {
        if (attempt === maxAttempts) return deterministic(facts, 'DETERMINISTICA_FALLBACK');
      }
    }
    return deterministic(facts, 'DETERMINISTICA_FALLBACK');
  }
}

