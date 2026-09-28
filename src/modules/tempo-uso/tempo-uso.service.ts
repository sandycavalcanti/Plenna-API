import { prisma } from '../../lib/prisma.js';
import { CreateTempoUsoDTO, SyncTempoUsoDTO, UpdateTempoUsoDTO, criarSyncTempoUsoSchema, createTempoUsoSchema, updateTempoUsoSchema } from './tempo-uso.schemas.js';
import { AppError } from '../../errors/AppError.js';
import { APLICATIVOS_COMPRA, encontrarAplicativoCompra } from './aplicativos-compra.catalog.js';
import { sincronizarFotografiasAtomicamente, autorizarEscritaTempoUso } from './tempo-uso.sync.js';

import { segundosDoRegistro, minutosParaSegundos, duracaoLegada } from './tempo-uso.duracao.js';

function normalizarRegistroLegado<T extends {
  tempo_uso_minutos: unknown;
  tempo_uso_data: Date | null;
  tempo_uso_inicio: Date | null;
  tempo_uso_duracao_segundos: number | null;
}>(registro: T) {
  const segundos = segundosDoRegistro(registro);
  return {
    ...registro,
    tempo_uso_duracao_segundos: segundos,
    tempo_uso_minutos: segundos === null ? null : segundos / 60,
    tempo_uso_data: registro.tempo_uso_data ?? registro.tempo_uso_inicio,
  };
}

export class TempoUsoService {
  static async create(userId: number, data: CreateTempoUsoDTO) {
    return prisma.$transaction(async tx => {
      await autorizarEscritaTempoUso(tx, userId);
      const entrada = createTempoUsoSchema.parse(data);
      const tempo = await tx.tb_tempo_uso.create({ data: {
        usuario_id: userId, tempo_uso_nome: entrada.nome, tempo_uso_data: entrada.data,
        ...duracaoLegada(minutosParaSegundos(entrada.minutos)),
      } });
      return normalizarRegistroLegado(tempo);
    });
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
    return prisma.$transaction(async tx => {
      await autorizarEscritaTempoUso(tx, userId);
      const entrada = updateTempoUsoSchema.parse(data);
      const tempo = await tx.tb_tempo_uso.findFirst({ where: { tempo_uso_id: id, usuario_id: userId } });
      if (!tempo) throw new AppError('Registro de tempo não encontrado', 404);
      if (tempo.tempo_uso_origem !== 'LEGADO') throw new AppError('Registro Android não pode ser editado pelo endpoint legado', 409);
      const segundos = entrada.minutos === undefined ? segundosDoRegistro(tempo) : minutosParaSegundos(entrada.minutos);
      if (segundos === null) throw new AppError('Informe uma duração válida para atualizar este registro legado', 400);
      const atualizado = await tx.tb_tempo_uso.update({ where: { tempo_uso_id: id }, data: {
        tempo_uso_nome: entrada.nome, tempo_uso_data: entrada.data, ...duracaoLegada(segundos),
      } });
      return normalizarRegistroLegado(atualizado);
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
    return sincronizarFotografiasAtomicamente(prisma, userId, () => {
      const entrada = criarSyncTempoUsoSchema().parse(data);
      const fotografias = entrada.registros.map((registro) => {
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

      return fotografias;
    });
  }
}
