import { z } from 'zod';
import { cents } from '../compra/financeiro.js';
import {
  respostasContextoSchema,
  planejamentoSchema,
} from './contexto.schemas.js';

export const VERSAO_MOTOR = 'contextual-2';
const dinheiro = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .nullable();
export const entradaInterpretacaoSchema = z
  .object({
    compraId: z.number().int().positive(),
    ativa: z.boolean(),
    status: z.enum(['CONFIRMADA', 'AGUARDANDO_CONFIRMACAO', 'IGNORADA']),
    valor: dinheiro,
    limite: dinheiro,
    contextoRevisao: z.number().int().nonnegative(),
    respostas: respostasContextoSchema,
    itens: z.array(
      z
        .object({
          itemId: z.number().int().positive(),
          ativo: z.boolean(),
          nome: z.string().min(1).optional(),
          planejamento: planejamentoSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.itens.map((i) => i.itemId)).size !== v.itens.length)
      ctx.addIssue({ code: 'custom', message: 'Itens repetidos' });
  });
const fato = z
  .object({
    codigo: z.string(),
    mensagem: z.string(),
    referencias: z.array(z.string()).min(1),
  })
  .strict();
const declaracao = fato
  .extend({
    campo: z.string(),
    valor: z.string(),
    itemId: z.number().int().positive().optional(),
  })
  .strict();
export const resultadoInterpretacaoSchema = z
  .object({
    versaoContrato: z.literal(1),
    versaoMotor: z.enum(['contextual-1', 'contextual-2']),
    compraId: z.number().int().positive(),
    contextoRevisao: z.number().int().nonnegative(),
    estado: z.enum([
      'NAO_AVALIAVEL',
      'DADOS_INSUFICIENTES',
      'CONTEXTO_DISPONIVEL',
    ]),
    observacoes: z.array(fato),
    declaracoes: z.array(declaracao),
    autopercepcao: declaracao.nullable(),
    interpretacao: z
      .object({
        mensagem: z.string(),
        reflexao: z.string().nullable(),
        referencias: z.array(z.string()),
      })
      .strict(),
    evidencias: z.array(
      z
        .object({
          referencia: z.string(),
          natureza: z.enum(['REGISTRADO', 'DECLARADO']),
        })
        .strict(),
    ),
    limitacoes: z.array(z.string()),
    regrasAplicadas: z.array(
      z
        .object({
          codigo: z.string(),
          versao: z.literal(1),
          justificativa: z.string(),
          referencias: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type ResultadoInterpretacao = z.infer<
  typeof resultadoInterpretacaoSchema
>;
const textos: Record<string, Record<string, string>> = {
  planejamento: {
    SIM: 'Você informou que a compra estava planejada.',
    PARCIALMENTE: 'Você informou que a compra estava parcialmente planejada.',
    NAO: 'Você informou que a compra não estava planejada.',
  },
  influenciaPromocional: {
    SIM: 'Você informou que uma promoção influenciou sua decisão.',
    NAO: 'Você informou que uma promoção não influenciou sua decisão.',
  },
  necessidadeInesperada: {
    SIM: 'Você informou que surgiu uma necessidade inesperada.',
    NAO: 'Você informou que não surgiu uma necessidade inesperada.',
  },
  momento: {
    ANTECIPADA: 'Você informou que antecipou a compra.',
    ADIADA: 'Você informou que adiou a compra.',
    NO_MOMENTO_PREVISTO: 'Você informou que comprou no momento previsto.',
  },
  autopercepcaoImpulsividade: {
    SIM: 'Na sua autopercepção, houve impulso nessa decisão.',
    NAO: 'Na sua autopercepção, não houve impulso nessa decisão.',
  },
};
const incerta = (v: string) =>
  v === 'NAO_LEMBRO' || v === 'PREFIRO_NAO_RESPONDER';
const nomes: Record<string, string> = {
  planejamento: 'Planejamento',
  influenciaPromocional: 'Influência promocional',
  necessidadeInesperada: 'Necessidade inesperada',
  momento: 'Momento da compra',
  autopercepcaoImpulsividade: 'Autopercepção',
};
const nomesPlanejamento: Record<string, string> = {
  SIM: 'planejado',
  NAO: 'não planejado',
  PARCIALMENTE: 'parcialmente planejado',
  NAO_LEMBRO: 'não lembro',
  PREFIRO_NAO_RESPONDER: 'prefiro não responder',
};

/** Usa somente as declarações do snapshot, sem inferir respostas nem gravar classificações. */
export function interpretarCompra(raw: unknown): ResultadoInterpretacao {
  const input = entradaInterpretacaoSchema.parse(raw);
  const observacoes: ResultadoInterpretacao['observacoes'] = [],
    declaracoes: ResultadoInterpretacao['declaracoes'] = [],
    regras: ResultadoInterpretacao['regrasAplicadas'] = [];
  const evidencias = new Map<string, 'REGISTRADO' | 'DECLARADO'>();
  const limitacoes = [
    'NAO_DIAGNOSTICA_IMPULSIVIDADE',
    'REFERENCIA_ATUAL_SEM_VIGENCIA_HISTORICA',
    'HORARIO_EFETIVO_NAO_COMPROVADO',
    'HISTORICO_SEM_COBERTURA_COMPLETA',
  ];
  const compraRef = `compra:${input.compraId}`,
    contextoRef = `contexto:${input.compraId}:revisao:${input.contextoRevisao}`;
  evidencias.set(compraRef, 'REGISTRADO');
  const regra = (
    codigo: string,
    justificativa: string,
    referencias: string[],
  ) => regras.push({ codigo, versao: 1, justificativa, referencias });
  if (!input.ativa || input.status !== 'CONFIRMADA')
    return resultadoInterpretacaoSchema.parse({
      versaoContrato: 1,
      versaoMotor: VERSAO_MOTOR,
      compraId: input.compraId,
      contextoRevisao: input.contextoRevisao,
      estado: 'NAO_AVALIAVEL',
      observacoes: [],
      declaracoes: [],
      autopercepcao: null,
      interpretacao: {
        mensagem: 'Esta compra não está ativa e confirmada para análise.',
        reflexao: null,
        referencias: [compraRef],
      },
      evidencias: [{ referencia: compraRef, natureza: 'REGISTRADO' }],
      limitacoes: [...limitacoes, 'COMPRA_NAO_ELEGIVEL'],
      regrasAplicadas: [],
    });
  if (input.valor === null) limitacoes.push('VALOR_DESCONHECIDO');
  if (input.limite === null || cents(input.limite) === 0)
    limitacoes.push('LIMITE_INDISPONIVEL');
  else if (input.valor !== null) {
    const excesso = Math.max(0, cents(input.valor) - cents(input.limite));
    const refs = [compraRef, 'perfil:limite-atual'];
    evidencias.set(refs[1]!, 'DECLARADO');
    observacoes.push({
      codigo: excesso > 0 ? 'LIMITE_EXCEDIDO' : 'SEM_EXCESSO_CONHECIDO',
      mensagem:
        excesso > 0
          ? `O valor registrado supera a referência individual atual em ${(excesso / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Isso não determina impulsividade.`
          : 'O valor registrado não supera a referência individual atual. Isso não comprova planejamento.',
      referencias: refs,
    });
    regra(
      'R1_LIMITE',
      'Comparação em centavos com a referência individual atual; sem conclusão comportamental.',
      refs,
    );
  }
  let autopercepcao: ResultadoInterpretacao['autopercepcao'] = null;
  const regrasCampos: Record<string, string> = {
    planejamento: 'R2_PLANEJAMENTO',
    influenciaPromocional: 'R4_PROMOCAO',
    necessidadeInesperada: 'R5_NECESSIDADE',
    momento: 'R6_MOMENTO',
    autopercepcaoImpulsividade: 'R8_AUTOPERCEPCAO',
  };
  for (const campo of [
    'planejamento',
    'influenciaPromocional',
    'necessidadeInesperada',
    'momento',
    'autopercepcaoImpulsividade',
  ] as const) {
    const valor = input.respostas[campo];
    if (valor === undefined) continue;
    const ref = `${contextoRef}:${campo}`;
    evidencias.set(ref, 'DECLARADO');
    const mensagem = incerta(valor)
      ? `${nomes[campo]}: ${valor === 'NAO_LEMBRO' ? 'você informou que não lembra.' : 'você preferiu não responder.'}`
      : textos[campo]![valor]!;
    const d = {
      codigo: regrasCampos[campo]!,
      campo,
      valor,
      mensagem,
      referencias: [ref],
    };
    if (campo === 'autopercepcaoImpulsividade') autopercepcao = d;
    else declaracoes.push(d);
    regra(
      regrasCampos[campo]!,
      'Registro de declaração voluntária, sem inferência e sem alteração da classificação legada.',
      [ref],
    );
    if (incerta(valor)) limitacoes.push(`${campo}:${valor}`);
  }
  const ativos = input.itens
    .filter((i) => i.ativo)
    .sort((a, b) => a.itemId - b.itemId);
  for (const item of ativos) {
    if (!item.planejamento) continue;
    const ref = `${contextoRef}:item:${item.itemId}`;
    evidencias.set(ref, 'DECLARADO');
    declaracoes.push({
      codigo: 'R3_ITEM',
      campo: 'planejamentoItem',
      itemId: item.itemId,
      valor: item.planejamento,
      mensagem: `${item.nome ?? 'Item informado'}: planejamento declarado como ${nomesPlanejamento[item.planejamento]}.`,
      referencias: [ref],
    });
    regra(
      'R3_ITEM',
      'Considera somente a resposta deste item ativo; não define o planejamento da compra inteira.',
      [ref],
    );
    if (incerta(item.planejamento))
      limitacoes.push(`item:${item.itemId}:${item.planejamento}`);
  }
  if (ativos.some((i) => !i.planejamento))
    limitacoes.push('ITENS_COM_CONTEXTO_AUSENTE');
  if (!input.respostas.planejamento)
    limitacoes.push('PLANEJAMENTO_GERAL_AUSENTE');
  const relevantes = declaracoes.filter((d) => !incerta(d.valor));
  const refs = relevantes.flatMap((d) => d.referencias);
  const temContexto = relevantes.length > 0;
  // Destacamos um tema sustentado pelas respostas; as declarações completas continuam nos detalhes.
  let reflexao: string | null = null;
  const r = input.respostas;
  if (temContexto) {
    if (r.planejamento === 'NAO' && r.influenciaPromocional === 'SIM')
      reflexao =
        'Você contou que a compra não estava planejada e que uma promoção influenciou sua decisão. A oferta antecipou uma necessidade ou despertou uma vontade nova?';
    else if (r.necessidadeInesperada === 'SIM')
      reflexao =
        'Você contou que surgiu uma necessidade inesperada. O que ajudaria a se preparar para situações semelhantes?';
    else if (r.influenciaPromocional === 'SIM')
      reflexao =
        'Você contou que uma promoção influenciou sua decisão. O que teria escolhido sem essa oferta?';
    else if (r.planejamento === 'PARCIALMENTE')
      reflexao =
        'Você contou que parte da compra estava planejada. O que contribuiu para escolher o que não estava previsto?';
    else if (r.planejamento === 'NAO')
      reflexao =
        'Você contou que a compra não estava planejada. O que contribuiu para essa escolha naquele momento?';
    else if (r.planejamento === 'SIM')
      reflexao =
        'Você contou que a compra estava planejada. O resultado correspondeu ao que esperava?';
    else if (r.momento === 'ANTECIPADA')
      reflexao =
        'Você contou que antecipou a compra. O que motivou essa mudança de momento?';
    else if (r.momento === 'ADIADA')
      reflexao =
        'Você contou que adiou a compra. O que ajudou a escolher esse momento?';
    else if (r.momento === 'NO_MOMENTO_PREVISTO')
      reflexao =
        'Você contou que comprou no momento previsto. O que ajudou a manter esse plano?';
    else if (relevantes.some((d) => d.campo === 'planejamentoItem'))
      reflexao =
        'Você informou o planejamento dos itens. O que foi importante na escolha de cada um?';
  }
  if (temContexto)
    regra(
      'R7_CONTEXTO',
      'Reflexão neutra restrita às declarações disponíveis; não conclui impulsividade.',
      refs,
    );
  else limitacoes.push('CONTEXTO_INSUFICIENTE_PARA_REFLEXAO');
  return resultadoInterpretacaoSchema.parse({
    versaoContrato: 1,
    versaoMotor: VERSAO_MOTOR,
    compraId: input.compraId,
    contextoRevisao: input.contextoRevisao,
    estado: temContexto ? 'CONTEXTO_DISPONIVEL' : 'DADOS_INSUFICIENTES',
    observacoes,
    declaracoes,
    autopercepcao,
    interpretacao: {
      mensagem: temContexto
        ? 'As informações declaradas ajudam a contextualizar esta decisão, sem determinar impulsividade.'
        : 'Não há contexto suficiente para uma reflexão contextual. Isso não significa ausência de sinais.',
      reflexao,
      referencias: refs,
    },
    evidencias: [...evidencias].map(([referencia, natureza]) => ({
      referencia,
      natureza,
    })),
    limitacoes,
    regrasAplicadas: regras,
  });
}
