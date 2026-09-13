import { prisma } from '../../lib/prisma.js';
import { CreateTempoUsoDTO, SyncTempoUsoDTO, UpdateTempoUsoDTO } from './tempo-uso.schemas.js';
import { AppError } from '../../errors/AppError.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
import { APLICATIVOS_COMPRA, encontrarAplicativoCompra } from './aplicativos-compra.catalog.js';
import { sincronizarFotografiasAtomicamente, TempoUsoTransactionRunner } from './tempo-uso.sync.js';

function normalizarRegistroLegado<T extends {
  tempo_uso_minutos: unknown;
  tempo_uso_data: Date | null;
  tempo_uso_inicio: Date | null;
  tempo_uso_duracao_segundos: number | null;
}>(registro: T) {
  return {
    ...registro,
    tempo_uso_minutos: registro.tempo_uso_minutos ?? (
      registro.tempo_uso_duracao_segundos === null ? null : registro.tempo_uso_duracao_segundos / 60
    ),
    tempo_uso_data: registro.tempo_uso_data ?? registro.tempo_uso_inicio,
  };
}

export class TempoUsoService {
  static async create(userId: number, data: CreateTempoUsoDTO) {
    const permitido = await ConsentimentoService.temConsentimentoAtivo(userId, CONSENTIMENTO_CODIGOS.MONITORAMENTO_TEMPO_USO);
    if (!permitido) {
      throw new AppError('O monitoramento de tempo de uso não está autorizado', 403);
    }

    const now = new Date();
    const tempo = await prisma.tb_tempo_uso.create({
      data: {
        usuario_id: userId,
        tempo_uso_nome: data.nome,
        tempo_uso_minutos: data.minutos,
        tempo_uso_data: data.data,
        tempo_uso_data_criacao: now,
      },
    });
    return tempo;
  }

  static async findAllByUserId(userId: number) {
    const registros = await prisma.tb_tempo_uso.findMany({
      where: { usuario_id: userId },
      orderBy: { tempo_uso_data_criacao: 'desc' },
    });
    return registros.map(normalizarRegistroLegado);
  }

  static async findById(userId: number, id: number) {
    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new AppError('Registro de tempo não encontrado', 404);
    return normalizarRegistroLegado(tempo);
  }

  static async update(userId: number, id: number, data: UpdateTempoUsoDTO) {
    const permitido = await ConsentimentoService.temConsentimentoAtivo(userId, CONSENTIMENTO_CODIGOS.MONITORAMENTO_TEMPO_USO);
    if (!permitido) {
      throw new AppError('O monitoramento de tempo de uso não está autorizado', 403);
    }

    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new AppError('Registro de tempo não encontrado', 404);

    return prisma.tb_tempo_uso.update({
      where: { tempo_uso_id: id },
      data: {
        tempo_uso_nome: data.nome,
        tempo_uso_minutos: data.minutos,
        tempo_uso_data: data.data,
      },
    });
  }

  static async delete(userId: number, id: number) {
    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new AppError('Registro de tempo não encontrado', 404);

    await prisma.tb_tempo_uso.delete({ where: { tempo_uso_id: id } });
  }

  static listarAplicativosCompra() {
    return { versao: 1, aplicativos: APLICATIVOS_COMPRA };
  }

  static async sync(userId: number, data: SyncTempoUsoDTO) {
    const permitido = await ConsentimentoService.temConsentimentoAtivo(
      userId,
      CONSENTIMENTO_CODIGOS.MONITORAMENTO_TEMPO_USO,
    );
    if (!permitido) {
      throw new AppError('O monitoramento de tempo de uso não está autorizado', 403);
    }

    const fotografias = data.registros.map((registro) => {
      const aplicativo = encontrarAplicativoCompra(registro.packageId);
      if (!aplicativo) {
        throw new AppError(`Aplicativo não autorizado para monitoramento: ${registro.packageId}`, 422);
      }
      return {
        packageId: aplicativo.packageId,
        nomeApp: aplicativo.nomeApp,
        inicio: new Date(registro.inicio),
        fim: new Date(registro.fim),
        duracaoSegundos: registro.duracaoSegundos,
        dataLocal: new Date(`${registro.dataLocal}T00:00:00.000Z`),
        timezone: registro.timezone,
      };
    });

    return sincronizarFotografiasAtomicamente(
      prisma as unknown as TempoUsoTransactionRunner,
      userId,
      fotografias,
    );
  }
}
