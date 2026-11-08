export const VERSAO_POLITICA_TEMPORAL = 'temporal-1';
const DAY = 86400000;
/** A timestamp in a legacy row is not proof of a transaction's exact time. */
export function dataElegivel(row) {
    return (row.ativa &&
        row.status === 'CONFIRMADA' &&
        row.data !== null &&
        row.precisao !== 'DESCONHECIDA' &&
        row.precisao !== 'APROXIMADA');
}
export function baseTemporal(rows, declaracoes = false) {
    const eligible = rows.filter(dataElegivel);
    const dates = eligible.map((r) => Date.parse(r.data));
    const periodo = dates.length
        ? {
            inicio: new Date(dates.reduce((a, b) => Math.min(a, b)))
                .toISOString()
                .slice(0, 10),
            fimInclusivo: new Date(dates.reduce((a, b) => Math.max(a, b)))
                .toISOString()
                .slice(0, 10),
        }
        : null;
    const recorded = eligible
        .flatMap((r) => (r.contexto?.registradaEm ? [r.contexto.registradaEm] : []))
        .sort();
    return {
        analisado: periodo,
        cobertura: 'REGISTROS_DISPONIVEIS_SEM_GARANTIA_DE_CONTINUIDADE',
        ...(declaracoes
            ? {
                declaracoesRegistradas: recorded.length
                    ? {
                        inicio: recorded[0],
                        fimInclusivo: recorded[recorded.length - 1],
                    }
                    : null,
                vigenciaNaCompraComprovada: false,
            }
            : {}),
        registros: eligible.length,
        disponivel: periodo,
        continuidadeComprovada: false,
        origens: [...new Set(eligible.map((r) => r.origem))],
        precisao: eligible.length &&
            eligible.every((r) => r.precisao === 'INSTANTE' && r.origem !== 'EMAIL')
            ? 'INSTANTE'
            : 'DIA_OU_INSUFICIENTE',
        datasDeMensagemEmail: eligible.filter((r) => r.referenciaData === 'MENSAGEM_EMAIL').length,
    };
}
/** Account creation and the first purchase never establish continuous coverage. */
export function comparacaoTemporal(duracao, cobertura) {
    return {
        elegivel: duracao > 0 && cobertura === 'COMPLETA',
        motivo: duracao <= 0
            ? 'JANELA_SEM_OBSERVACAO'
            : cobertura !== 'COMPLETA'
                ? 'COBERTURA_NAO_COMPLETA'
                : null,
    };
}
/** Only explicitly authorized, validated collection windows can support monitoring. */
export function coberturaMonitoramento(inicio, fim, intervalos) {
    const windows = intervalos
        .filter((i) => i.autorizado && i.valido && i.fim > i.inicio)
        .map((i) => ({
        inicio: Math.max(inicio, i.inicio),
        fim: Math.min(fim, i.fim),
    }))
        .filter((i) => i.fim > i.inicio)
        .sort((a, b) => a.inicio - b.inicio);
    let covered = 0, end = inicio;
    for (const w of windows) {
        covered += Math.max(0, w.fim - Math.max(end, w.inicio));
        end = Math.max(end, w.fim);
    }
    return {
        disponibilidade: !covered
            ? 'INDISPONIVEL'
            : covered === fim - inicio
                ? 'DISPONIVEL'
                : 'PARCIAL',
        diasComCobertura: covered ? covered / DAY : null,
        tempoUso: null,
    };
}
