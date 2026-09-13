export type FotografiaTempoUso = {
  packageId: string;
  nomeApp: string;
  inicio: Date;
  fim: Date;
  duracaoSegundos: number;
  dataLocal: Date;
  timezone: string;
};

export type TempoUsoUpsertRepository = {
  upsert(args: unknown): Promise<unknown>;
};

export type TempoUsoTransaction = {
  tb_tempo_uso: TempoUsoUpsertRepository;
};

export type TempoUsoTransactionRunner = {
  $transaction<T>(callback: (transaction: TempoUsoTransaction) => Promise<T>): Promise<T>;
};

export async function sincronizarFotografiasAtomicamente(
  database: TempoUsoTransactionRunner,
  usuarioId: number,
  fotografias: FotografiaTempoUso[],
) {
  return database.$transaction(async (transaction) => {
    for (const fotografia of fotografias) {
      await transaction.tb_tempo_uso.upsert({
        where: {
          tempo_uso_usuario_package_periodo_unique: {
            usuario_id: usuarioId,
            tempo_uso_package_id: fotografia.packageId,
            tempo_uso_inicio: fotografia.inicio,
            tempo_uso_fim: fotografia.fim,
          },
        },
        create: {
          usuario_id: usuarioId,
          tempo_uso_nome: fotografia.nomeApp,
          tempo_uso_package_id: fotografia.packageId,
          tempo_uso_inicio: fotografia.inicio,
          tempo_uso_fim: fotografia.fim,
          tempo_uso_duracao_segundos: fotografia.duracaoSegundos,
          tempo_uso_data_local: fotografia.dataLocal,
          tempo_uso_timezone: fotografia.timezone,
          tempo_uso_origem: 'ANDROID_USAGE_STATS',
        },
        update: {
          tempo_uso_nome: fotografia.nomeApp,
          tempo_uso_duracao_segundos: fotografia.duracaoSegundos,
          tempo_uso_data_local: fotografia.dataLocal,
          tempo_uso_timezone: fotografia.timezone,
          tempo_uso_origem: 'ANDROID_USAGE_STATS',
        },
      });
    }

    return { recebidos: fotografias.length, persistidos: fotografias.length };
  });
}
