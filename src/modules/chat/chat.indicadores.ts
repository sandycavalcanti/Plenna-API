import { DescobertasService } from '../rf018/descobertas.service.js';

export function assuntoIndicadores(texto: string) {
  const t = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/reembolso|cancelad|devolvid|classifiquei|limite.*epoca/.test(t))
    return 'EVENTOS';
  if (
    /o que.*observou|diferentes? do meu padrao|por que.*compra.*(?:atencao|chamou)|sinais.*compras|descobertas automaticas/.test(
      t,
    )
  )
    return 'AUTOMATICO';
  if (
    /compuls|por impulso|impulsiv/.test(t) &&
    /tenho|meu|minha|estou|compro|comprado/.test(t)
  )
    return 'CONTEXTO';
  if (/comprando mais|frequencia|mais do que antes/.test(t))
    return 'FREQUENCIA';
  if (
    /quais compras.*orcamento|quais categorias|quanto (?:eu )?gast|quanto.*orcamento|ultrapassei.*orcamento/.test(
      t,
    )
  )
    return 'FINANCEIRO';
  return null;
}
type Resumo = Awaited<ReturnType<typeof DescobertasService.consultar>>;
export function responderIndicadores(texto: string, dados: Resumo | null) {
  const assunto = assuntoIndicadores(texto);
  if (!assunto) return null;
  const prefix = dados ? `Nos registros de ${dados.periodo}: ` : '';
  if (assunto === 'AUTOMATICO') {
    const a = dados?.avaliacaoAutomatica;
    if (!a)
      return 'Não consegui consultar a análise automática agora. Confira as descobertas no aplicativo.';
    if (a.estado === 'DADOS_INSUFICIENTES')
      return (
        prefix +
        'Ainda faltam registros ou referências suficientes para esta avaliação. A ausência de sinais calculáveis não significa ausência de impulso.'
      );
    if (a.estado === 'SEM_SINAIS_RELEVANTES')
      return (
        prefix +
        'As regras disponíveis não identificaram diferenças relevantes. Isso não classifica as compras como não impulsivas; outras referências podem estar indisponíveis.'
      );
    return (
      prefix +
      a.descobertas.map((d) => d.mensagem).join(' ') +
      ' As evidências e limitações estão disponíveis na análise da compra, na área protegida. A classificação continua sendo uma escolha sua.'
    );
  }
  if (assunto === 'EVENTOS') {
    const e = dados?.eventos;
    if (!e?.disponivel)
      return 'O histórico dessas operações ainda não está disponível. Você pode consultar os registros na área protegida de Minhas compras.';
    return (
      prefix +
      `${e.cancelamentos} compra(s) com cancelamento declarado e ${e.devolucoes} com devolução, considerando compras desse mês. Reembolsos com data efetiva no mês: ${(e.reembolsadoCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Cancelamento ou devolução não comprova reembolso. ` +
      (e.reembolsosSemData
        ? 'Há reembolsos sem data, fora desse total mensal. '
        : '') +
      `${e.classificadasImpulsivas} compra(s) desse mês foram classificadas voluntariamente como impulsivas. Para detalhes e referências da época, abra a compra na área protegida.`
    );
  }
  if (assunto === 'CONTEXTO') {
    const p = dados?.historico?.planejamento;
    return (
      'Frequência e valores não determinam impulsividade ou compulsividade.' +
      (p?.conhecidas
        ? ` Você declarou ${p.contagens.SIM} compra(s) planejada(s), ${p.contagens.PARCIALMENTE} em parte e ${p.contagens.NAO} não planejada(s), entre ${p.conhecidas} respostas conhecidas em ${dados!.periodo}.`
        : ' Ainda não tenho respostas suficientes para contextualizar suas decisões.') +
      ' Como você percebe seu controle sobre essas compras?'
    );
  }
  if (assunto === 'FREQUENCIA') {
    const f = dados?.historico?.frequencia;
    return f && f.disponibilidade !== 'INDISPONIVEL'
      ? prefix +
          `${f.comprasAtual} compra(s) no trecho atual e ${f.comprasAnterior} no anterior, em janelas de ${f.diasComparados.toLocaleString('pt-BR')} dias. Isso descreve os registros, sem estabelecer uma tendência.`
      : 'Ainda não há períodos comparáveis suficientes para dizer se você está comprando mais.';
  }
  const f = dados?.financeiro;
  return f
    ? prefix +
        `${f.financeiro.comprasConfirmadas} compra(s). ` +
        (f.financeiro.comprasComValor > 0
          ? `${(f.financeiro.totalConhecidoCentavos! / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em valores conhecidos. `
          : 'Valores ainda não informados. ') +
        'Para conferir quais compras ou categorias contribuíram, abra Minhas compras e selecione o período; os detalhes continuam protegidos por PIN ou biometria.'
    : 'Não consegui consultar o resumo agora. Você pode conferir os registros em Minhas compras.';
}
/** First-party answer: never sends financial/contextual records to an external AI provider. */
export async function consultarRespostaIndicadores(
  userId: number,
  texto: string,
) {
  if (!assuntoIndicadores(texto)) return null;
  const dates = [...texto.matchAll(/\b([1-9]\d{3}-(?:0[1-9]|1[0-2]))\b/g)];
  if (dates.length > 1)
    return 'Escolha um período por vez, no formato AAAA-MM, para consultar os registros.';
  const periodo = dates[0]?.[1] ?? new Date().toISOString().slice(0, 7);
  try {
    return responderIndicadores(
      texto,
      await DescobertasService.consultar(userId, periodo),
    );
  } catch {
    return responderIndicadores(texto, null);
  }
}
