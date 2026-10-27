import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parseMonth } from '../compra/financeiro.js';
import { criarSyncTempoUsoSchema } from '../tempo-uso/tempo-uso.schemas.js';
import { TEMPO_USO_SCHEMA_VERSION } from '../tempo-uso/tempo-uso.constants.js';
import { encontrarAplicativoCompra } from '../tempo-uso/aplicativos-compra.catalog.js';

type Registro = {
  tempo_uso_id: number;
  tempo_uso_package_id: string | null;
  tempo_uso_nome: string;
  tempo_uso_inicio: Date | null;
  tempo_uso_fim: Date | null;
  tempo_uso_data_local: Date | null;
  tempo_uso_timezone: string | null;
  tempo_uso_duracao_segundos: number | null;
  tempo_uso_data_criacao: Date;
  tempo_uso_data_modificacao: Date;
  tempo_uso_origem: string;
};

export function resumirUsoAutorizado(
  registros: Registro[],
  autorizacao: Date,
  now: Date,
) {
  const valid = registros.filter((r) => {
    if (
      r.tempo_uso_origem !== 'ANDROID_USAGE_STATS' ||
      !encontrarAplicativoCompra(r.tempo_uso_package_id ?? '') ||
      !r.tempo_uso_inicio ||
      !r.tempo_uso_fim ||
      !r.tempo_uso_data_local ||
      r.tempo_uso_inicio < autorizacao ||
      r.tempo_uso_data_criacao < autorizacao ||
      r.tempo_uso_data_criacao > now ||
      r.tempo_uso_data_modificacao < r.tempo_uso_data_criacao ||
      r.tempo_uso_data_modificacao > now
    )
      return false;
    const validation = criarSyncTempoUsoSchema(
      r.tempo_uso_data_modificacao,
    ).safeParse({
      schemaVersion: TEMPO_USO_SCHEMA_VERSION,
      registros: [
        {
          packageId: r.tempo_uso_package_id,
          dataLocal: r.tempo_uso_data_local.toISOString().slice(0, 10),
          timezone: r.tempo_uso_timezone,
          inicio: r.tempo_uso_inicio.toISOString(),
          fim: r.tempo_uso_fim.toISOString(),
          duracaoSegundos: r.tempo_uso_duracao_segundos,
        },
      ],
    });
    return validation.success;
  });
  // Fotografias sobrepostas do mesmo aplicativo não podem ser somadas como intervalos independentes.
  const safe = valid.filter(
    (r, i) =>
      !valid.some(
        (other, j) =>
          i !== j &&
          r.tempo_uso_package_id === other.tempo_uso_package_id &&
          r.tempo_uso_inicio! < other.tempo_uso_fim! &&
          other.tempo_uso_inicio! < r.tempo_uso_fim!,
      ),
  );
  const dias = [
    ...new Set(
      safe.map((r) => r.tempo_uso_data_local!.toISOString().slice(0, 10)),
    ),
  ].sort();
  const porDia = dias.map((data) => ({
    data,
    minutos:
      safe
        .filter(
          (r) => r.tempo_uso_data_local!.toISOString().slice(0, 10) === data,
        )
        .reduce((sum, r) => sum + r.tempo_uso_duracao_segundos!, 0) / 60,
  }));
  const porAplicativo = [...new Set(safe.map((r) => r.tempo_uso_package_id!))]
    .sort()
    .map((packageId) => ({
      packageId,
      nome: encontrarAplicativoCompra(packageId)!.nomeApp,
      minutos:
        safe
          .filter((r) => r.tempo_uso_package_id === packageId)
          .reduce((sum, r) => sum + r.tempo_uso_duracao_segundos!, 0) / 60,
    }));
  return {
    disponibilidade: safe.length
      ? ('PARCIAL' as const)
      : ('SEM_DADOS' as const),
    dias,
    porDia,
    porAplicativo,
    minutosRegistrados: safe.length
      ? safe.reduce((sum, r) => sum + r.tempo_uso_duracao_segundos!, 0) / 60
      : null,
    referencias: safe.map((r) => `tempo-uso:${r.tempo_uso_id}`),
    associacaoComCompra: 'INDISPONIVEL' as const,
    motivo: 'SEM_HORARIO_EFETIVO_DA_TRANSACAO' as const,
  };
}

/** A fonte opcional usa leitura separada para que sua falha não invalide a transação financeira. */
export async function consultarUsoAplicativos(
  userId: number,
  periodo: string,
  now: Date,
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const consent = await tx.tb_consentimento.findFirst({
          where: {
            usuario_id: userId,
            consentimento_status: true,
            tb_consentimento_tipo: {
              consentimento_tipo_codigo: 'MONITORAMENTO_TEMPO_USO',
            },
          },
          select: { consentimento_data_criacao: true },
        });
        if (!consent)
          return {
            disponibilidade: 'SEM_AUTORIZACAO' as const,
            dias: [],
            minutosRegistrados: null,
            referencias: [],
            associacaoComCompra: 'INDISPONIVEL' as const,
          };
        const { start, end } = parseMonth(periodo);
        const rows = await tx.tb_tempo_uso.findMany({
          where: {
            usuario_id: userId,
            tempo_uso_origem: 'ANDROID_USAGE_STATS',
            tempo_uso_data_local: { gte: start, lt: end },
            tempo_uso_inicio: { gte: consent.consentimento_data_criacao },
            tempo_uso_data_modificacao: { lte: now },
          },
          orderBy: [{ tempo_uso_inicio: 'asc' }, { tempo_uso_id: 'asc' }],
        });
        return resumirUsoAutorizado(
          rows,
          consent.consentimento_data_criacao,
          now,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch {
    return {
      disponibilidade: 'INDISPONIVEL' as const,
      dias: [],
      minutosRegistrados: null,
      referencias: [],
      associacaoComCompra: 'INDISPONIVEL' as const,
    };
  }
}
