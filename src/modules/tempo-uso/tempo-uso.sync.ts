import type { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';

// Mesmo lock de linha e ordem usados pela revogação em ConsentimentoService.
// Não importa o singleton Prisma: permite testes inteiramente isolados.
export async function autorizarEscritaTempoUso(tx: TempoUsoTransaction, usuarioId: number) {
  if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) throw new AppError('Token inválido', 401);
  const usuarios = await tx.$queryRaw<{ usuario_id: number }[]>`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${usuarioId} FOR UPDATE`;
  if (usuarios.length !== 1) throw new AppError('Usuário não encontrado', 404);
  const consentimento = await tx.tb_consentimento.findFirst({
    where: { usuario_id: usuarioId, consentimento_status: true,
      tb_consentimento_tipo: { consentimento_tipo_codigo: 'MONITORAMENTO_TEMPO_USO' } },
    select: { consentimento_id: true },
  });
  if (!consentimento) throw new AppError('O monitoramento de tempo de uso não está autorizado', 403);
}

export type FotografiaTempoUso = {
  packageId: string;
  nomeApp: string;
  inicio: Date;
  fim: Date;
  duracaoSegundos: number;
  dataLocal: Date;
  timezone: string;
};

export type TempoUsoTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | 'tb_consentimento' | 'tb_tempo_uso'>;

export type TempoUsoTransactionRunner = {
  $transaction<T>(callback: (transaction: TempoUsoTransaction) => Promise<T>): Promise<T>;
};

export async function sincronizarFotografiasAtomicamente(
  database: TempoUsoTransactionRunner,
  usuarioId: number,
  fotografiasOuPreparar: FotografiaTempoUso[] | (() => FotografiaTempoUso[]),
) {
  return database.$transaction(async (transaction) => {
    await autorizarEscritaTempoUso(transaction, usuarioId);
    const fotografias = typeof fotografiasOuPreparar === 'function' ? fotografiasOuPreparar() : fotografiasOuPreparar;
    // Uma consulta limitada aos packages/períodos do lote, nunca histórico inteiro.
    const existentes = await transaction.tb_tempo_uso.findMany({
      where: { usuario_id: usuarioId, OR: fotografias.map(f => ({
        tempo_uso_package_id: f.packageId,
        tempo_uso_inicio: { lt: f.fim }, tempo_uso_fim: { gt: f.inicio },
      })) },
      select: { tempo_uso_package_id: true, tempo_uso_inicio: true, tempo_uso_fim: true },
    });
    for (let i = 0; i < fotografias.length; i++) {
      const f = fotografias[i];
      if (fotografias.slice(0, i).some(outro => outro.packageId === f.packageId && outro.inicio < f.fim && outro.fim > f.inicio)) {
        throw new AppError('Períodos duplicados ou sobrepostos no lote', 400);
      }
      if (existentes.some(outro => outro.tempo_uso_package_id === f.packageId &&
        outro.tempo_uso_inicio! < f.fim && outro.tempo_uso_fim! > f.inicio &&
        !(outro.tempo_uso_inicio!.getTime() === f.inicio.getTime() && outro.tempo_uso_fim!.getTime() === f.fim.getTime()))) {
        throw new AppError('Período sobreposto a registro existente', 409);
      }
    }
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
