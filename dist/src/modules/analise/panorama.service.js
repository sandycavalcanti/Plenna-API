import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { validarPeriodoConta } from '../compra/periodo-conta.js';
import { AppError } from '../../errors/AppError.js';
import { comprasElegiveisAgregadoSql } from '../compra/eventos.consulta.js';
import { agregadoPanoramaSchema, periodoPanorama } from './panorama.schemas.js';
import { apresentarComportamentoPanorama, recorrenciasPanoramaSql } from './panorama.comportamento.js';
// A single statement/snapshot. Windowed set operations use the existing purchase,
// revision and correction indexes. Result size is independent of history length.
export function consultaPanoramaSql(userId, inicio, fim, detalhes, comportamento = false) {
    return Prisma.sql `WITH ${comprasElegiveisAgregadoSql(userId, inicio, fim, undefined, comportamento)},
    contextos AS MATERIALIZED (
      SELECT DISTINCT ON (c.compra_id) c.compra_id,c.contexto_id,c.respostas
      FROM public.tb_compra_contexto_revisao c JOIN elegiveis p ON p.compra_id=c.compra_id
      WHERE c.usuario_id=${userId} ORDER BY c.compra_id,c.revisao DESC
    ), itens AS MATERIALIZED (
      SELECT i.compra_id,bool_or(ic.planejamento='NAO') AS item_nao_planejado,
        bool_or(ic.planejamento IN ('SIM','NAO','PARCIALMENTE')) AS item_conhecido
      FROM public.tb_compra_item i JOIN elegiveis p ON p.compra_id=i.compra_id
      LEFT JOIN contextos c ON c.compra_id=p.compra_id
      LEFT JOIN public.tb_compra_item_contexto ic ON ic.contexto_id=c.contexto_id
        AND ic.compra_id=p.compra_id AND ic.compra_item_id=i.compra_item_id
      WHERE i.compra_item_ativo=1 GROUP BY i.compra_id
    ), base AS MATERIALIZED (
      SELECT p.*, c.respostas->>'planejamento' AS planejamento,
        c.respostas->>'influenciaPromocional' AS promocao,
        c.respostas->>'necessidadeInesperada' AS necessidade,
        c.respostas->>'momento' AS momento,
        c.respostas->>'autopercepcaoImpulsividade' AS autopercepcao,
        coalesce(i.item_nao_planejado,false) AS item_nao_planejado,
        coalesce(i.item_conhecido,false) AS item_conhecido
      FROM elegiveis p LEFT JOIN contextos c ON c.compra_id=p.compra_id
      LEFT JOIN itens i ON i.compra_id=p.compra_id
    ), medidas AS (
      SELECT v.codigo,count(*) FILTER (WHERE v.valido)::int AS validos,
        count(*) FILTER (WHERE v.valido AND v.condicao)::int AS condicao
      FROM base b CROSS JOIN LATERAL (VALUES
        ('PLANEJADA',planejamento IN ('SIM','NAO','PARCIALMENTE'),planejamento='SIM'),
        ('PARCIAL',planejamento IN ('SIM','NAO','PARCIALMENTE'),planejamento='PARCIALMENTE'),
        ('NAO_PLANEJADA',planejamento IN ('SIM','NAO','PARCIALMENTE'),planejamento='NAO'),
        ('PROMOCAO',promocao IN ('SIM','NAO'),promocao='SIM'),
        ('NECESSIDADE',necessidade IN ('SIM','NAO'),necessidade='SIM'),
        ('ANTECIPADA',momento IN ('ANTECIPADA','ADIADA','NO_MOMENTO_PREVISTO'),momento='ANTECIPADA'),
        ('ADIADA',momento IN ('ANTECIPADA','ADIADA','NO_MOMENTO_PREVISTO'),momento='ADIADA'),
        ('IMPULSO',autopercepcao IN ('SIM','NAO'),autopercepcao='SIM'),
        ('SEM_IMPULSO',autopercepcao IN ('SIM','NAO'),autopercepcao='NAO'),
        ('CLASSIFICADA_IMPULSIVA',compra_classificacao::text IN ('IMPULSIVA','NAO_IMPULSIVA'),compra_classificacao::text='IMPULSIVA'),
        ('CLASSIFICADA_NAO_IMPULSIVA',compra_classificacao::text IN ('IMPULSIVA','NAO_IMPULSIVA'),compra_classificacao::text='NAO_IMPULSIVA'),
        ('PROMOCAO_ANTECIPACAO',promocao IN ('SIM','NAO') AND momento IN ('ANTECIPADA','ADIADA','NO_MOMENTO_PREVISTO'),promocao='SIM' AND momento='ANTECIPADA'),
        ('PROMOCAO_IMPULSO',promocao IN ('SIM','NAO') AND autopercepcao IN ('SIM','NAO'),promocao='SIM' AND autopercepcao='SIM'),
        ('PARCIAL_ITENS',planejamento IN ('SIM','NAO','PARCIALMENTE') AND item_conhecido,planejamento='PARCIALMENTE' AND item_nao_planejado),
        ('NECESSIDADE_SEM_PLANO',necessidade IN ('SIM','NAO') AND planejamento IN ('SIM','NAO','PARCIALMENTE'),necessidade='SIM' AND planejamento='NAO')
      ) v(codigo,valido,condicao) GROUP BY v.codigo
    ), categorias AS (
      SELECT c.categoria_id,c.categoria_nome AS nome,count(DISTINCT p.compra_id)::int AS compras
      FROM elegiveis p JOIN public.tb_compra_item i ON i.compra_id=p.compra_id AND i.compra_item_ativo=1
      JOIN public.tb_categoria c ON c.categoria_id=i.categoria_id
      WHERE ${detalhes} GROUP BY c.categoria_id,c.categoria_nome ORDER BY compras DESC,c.categoria_id LIMIT 5
    ), dias AS (
      SELECT extract(dow FROM (compra_horario AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::int AS dia,
        count(*)::int AS compras FROM elegiveis WHERE ${detalhes} GROUP BY dia
    ) SELECT jsonb_build_object(
      'universo',count(*)::int,
      'comContexto',count(*) FILTER (WHERE planejamento IN ('SIM','NAO','PARCIALMENTE') OR promocao IN ('SIM','NAO')
        OR necessidade IN ('SIM','NAO') OR momento IN ('ANTECIPADA','ADIADA','NO_MOMENTO_PREVISTO')
        OR autopercepcao IN ('SIM','NAO') OR item_conhecido)::int,
      'comAutopercepcao',count(*) FILTER (WHERE autopercepcao IN ('SIM','NAO'))::int,
      'valoresValidos',count(compra_valor)::int,
      'totalCentavos',coalesce(sum(round(compra_valor*100)),0),
      'categoriasValidas',(SELECT count(DISTINCT i.compra_id)::int FROM public.tb_compra_item i JOIN elegiveis p ON p.compra_id=i.compra_id
        JOIN public.tb_categoria c ON c.categoria_id=i.categoria_id WHERE i.compra_item_ativo=1 AND ${detalhes}),
      'sinais',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY codigo) FROM medidas m
        WHERE codigo NOT IN ('PROMOCAO_ANTECIPACAO','PROMOCAO_IMPULSO','PARCIAL_ITENS','NECESSIDADE_SEM_PLANO')), '[]'::jsonb),
      'relacoes',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY codigo) FROM medidas m
        WHERE codigo IN ('PROMOCAO_ANTECIPACAO','PROMOCAO_IMPULSO','PARCIAL_ITENS','NECESSIDADE_SEM_PLANO')), '[]'::jsonb),
      'categorias',coalesce((SELECT jsonb_agg(jsonb_build_object('nome',nome,'compras',compras) ORDER BY compras DESC,categoria_id) FROM categorias),'[]'::jsonb),
      'diasSemana',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY dia) FROM dias d),'[]'::jsonb)
    ) AS agregado${comportamento ? Prisma.sql `, (${recorrenciasPanoramaSql(userId)}) AS recorrencias` : Prisma.empty} FROM base`;
}
export function apresentarPanorama(a, periodo, detalhes) {
    const indicador = (s, origem) => ({ ...s, universo: a.universo, periodo,
        proporcao: s.validos ? s.condicao / s.validos : null, origem, disponibilidade: s.validos ? 'DISPONIVEL' : 'SEM_DADOS' });
    const sinais = a.sinais.map(s => indicador(s, s.codigo.startsWith('CLASSIFICADA_') ? 'CLASSIFICACAO_REGISTRADA' : 'RESPOSTA_VOLUNTARIA'));
    const relacoes = a.relacoes.map(s => indicador(s, 'RESPOSTAS_NA_MESMA_COMPRA'));
    const repetida = relacoes.find(s => s.condicao > 1);
    const promocao = sinais.find(s => s.codigo === 'PROMOCAO');
    const categoria = a.categorias.find(c => c.compras > 1);
    const reflexao = repetida ? `Em ${repetida.condicao} de ${repetida.validos} compras com ambas as respostas conhecidas, ${repetida.codigo === 'PROMOCAO_ANTECIPACAO' ? 'promoção e antecipação' : repetida.codigo === 'PROMOCAO_IMPULSO' ? 'promoção e percepção de impulso' : repetida.codigo === 'PARCIAL_ITENS' ? 'planejamento parcial e itens não planejados' : 'necessidade inesperada e ausência de planejamento'} foram registrados juntos.`
        : promocao && promocao.condicao > 0 ? `Promoções foram declaradas em ${promocao.condicao} de ${promocao.validos} compras com resposta conhecida sobre promoção.`
            : categoria ? `A categoria ${categoria.nome} apareceu em ${categoria.compras} de ${a.categoriasValidas} compras com categoria registrada. A repetição pode atender a necessidades recorrentes.`
                : a.universo ? `${a.universo} ${a.universo === 1 ? 'compra elegível registrada' : 'compras elegíveis registradas'} no período. Os registros disponíveis não permitem concluir motivos psicológicos.`
                    : 'Nenhuma compra elegível neste período.';
    return { versaoContrato: 1, periodo, universo: a.universo, comContexto: a.comContexto, comAutopercepcao: a.comAutopercepcao,
        disponibilidade: a.universo ? 'DISPONIVEL' : 'SEM_DADOS', reflexao,
        ...(detalhes ? { sinais, relacoes, habitos: { origem: 'COMPRAS_REGISTRADAS', categorias: a.categorias.map(v => ({ ...v, ...indicador({ codigo: 'CATEGORIA', validos: a.categoriasValidas, condicao: v.compras }, 'COMPRAS_REGISTRADAS') })), categoriasValidas: a.categoriasValidas,
                diasSemana: a.diasSemana.map(v => ({ ...v, ...indicador({ codigo: 'DIA_SEMANA', validos: a.universo, condicao: v.compras }, 'COMPRAS_REGISTRADAS') })), valoresValidos: a.valoresValidos, totalCentavos: a.totalCentavos,
                comparacao: { disponibilidade: 'INDISPONIVEL', motivo: 'COBERTURA_CONTINUA_NAO_COMPROVADA' } } } : {}),
        limitacoes: ['Somente compras visíveis, ativas e confirmadas, sem cancelamento vigente e sem itens pessoais.',
            'Respostas voluntárias atuais; não comprovam o contexto vigente na data da compra.',
            'Frequência, promoção e repetição não determinam impulsividade ou compulsividade.'] };
}
export class PanoramaService {
    static async consultar(userId, raw, now = new Date()) {
        const { q, periodo } = periodoPanorama(raw, now);
        const user = await prisma.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true }, select: { usuario_data_criacao: true } });
        if (!user)
            throw new AppError('Usuário não encontrado', 404);
        validarPeriodoConta(q, user.usuario_data_criacao, now);
        const rows = await prisma.$queryRaw(consultaPanoramaSql(userId, periodo.inicio ? new Date(periodo.inicio) : null, new Date(periodo.observadoAte), q.detalhes === '1', q.comportamento === '1'));
        const agregado = agregadoPanoramaSchema.parse(rows[0]?.agregado);
        const result = apresentarPanorama(agregado, periodo, q.detalhes === '1');
        return q.comportamento === '1' ? { ...result, comportamento: apresentarComportamentoPanorama(rows[0]?.recorrencias, periodo, agregado.universo) } : result;
    }
}
