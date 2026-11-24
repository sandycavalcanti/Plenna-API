import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { revokeUsageAssociations } from '../tempo-uso-v2/consent.js';
import { prisma } from '../../lib/prisma.js';
import { CreateUserDTO, UpdateUserDTO } from './user.schemas.js';
import { AppError } from '../../errors/AppError.js';
import { registrarAlteracoesReferencia } from '../compra/referencias.service.js';

const SALT_ROUNDS = 10;

export class UsersService {
  // CREATE
  static async create(data: CreateUserDTO) {
    // Verificar se o email já existe
    const emailExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email },
    });
    if (emailExists) {
      throw new AppError('Email já cadastrado', 400);
    }
    // Hash da senha
    const passwordHash = await bcrypt.hash(data.senha, SALT_ROUNDS);
    const user = await prisma.tb_usuario.create({
      data: {
        usuario_email: data.email,
        usuario_senha: passwordHash,
        usuario_nome: data.nome,
        usuario_status: true,
        usuario_data_criacao: new Date(),
      },
    });
    return this.removePassword(user);
  }

  // LIST
  static async findAll() {
    const users = await prisma.tb_usuario.findMany({});
    return users.map(this.removePassword);
  }

  // GET BY ID
  static async findById(id: number) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: id,
        usuario_status: true,
      },
    });

    if (!user) throw new AppError('Usuário não encontrado', 404);

    return this.removePassword(user);
  }

  // GET BY EMAIL
  static async findByEmail(email: string) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_email: email,
        usuario_status: true,
      },
    });

    if (!user) throw new AppError('Usuário não encontrado', 404);

    return this.removePassword(user);
  }

  // UPDATE
  static async update(id: number, data: UpdateUserDTO) {
    await this.findById(id);
    const updateData: any = {};

    if (data.nome !== undefined) updateData.usuario_nome = data.nome;
    if (data.telefone !== undefined) updateData.usuario_telefone = data.telefone;
    if (data.dataNascimento !== undefined) updateData.usuario_data_nascimento = data.dataNascimento;
    if (data.limiteCompra !== undefined) updateData.usuario_limite_compra = data.limiteCompra;
    if (data.metaValorMensal !== undefined) updateData.usuario_meta_valor_mensal = data.metaValorMensal;
    if (data.metaValorCompra !== undefined) updateData.usuario_meta_valor_compra = data.metaValorCompra;
    if (data.metaTempo !== undefined) updateData.usuario_meta_tempo = data.metaTempo;
    if (data.gatilhoConsumo !== undefined) updateData.usuario_gatilho_consumo = data.gatilhoConsumo;
    if (data.tempoTela !== undefined) updateData.usuario_tempo_tela = data.tempoTela;
    if (data.incomodoConsumo !== undefined) updateData.usuario_incomodo_consumo = data.incomodoConsumo;

    const updated = await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${id} AND usuario_status=true FOR UPDATE`;
      const before=await tx.tb_usuario.findFirst({where:{usuario_id:id,usuario_status:true}});
      if(!before)throw new AppError('Usuário não encontrado',404);
      const result=await tx.tb_usuario.update({where:{usuario_id:id},data:updateData});
      const changes=[];
      if(data.metaValorCompra!==undefined&&String(before.usuario_meta_valor_compra)!==String(result.usuario_meta_valor_compra))changes.push({tipo:'LIMITE_COMPRA',valor:result.usuario_meta_valor_compra});
      if(data.metaValorMensal!==undefined&&(data.orcamentoVigencia||String(before.usuario_meta_valor_mensal)!==String(result.usuario_meta_valor_mensal)))changes.push({tipo:'ORCAMENTO_MENSAL',valor:result.usuario_meta_valor_mensal,aplicacao:data.orcamentoVigencia});
      await registrarAlteracoesReferencia(tx,id,changes);return result;
    });

    return this.removePassword(updated);
  }

  // DELETE (soft delete)
  static async delete(id: number) {
    await prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, id);

      // Preserve references to the old identity and release its login identifier.
      await tx.tb_usuario.update({
        where: { usuario_id: id },
        data: {
          usuario_status: false,
          usuario_email: `deleted:${id}`,
          usuario_senha: randomUUID(),
        },
      });

      const where = { usuario_id: id };
      await tx.tb_integracao.deleteMany({ where });
      await tx.tb_oauth_tentativa.deleteMany({ where });
      await tx.tb_redefinicao_senha.deleteMany({ where });
      const [pushStorage] = await tx.$queryRaw<{ relation: string | null }[]>`
        SELECT to_regclass('public.tb_dispositivo')::text AS relation
      `;
      if (pushStorage?.relation) await tx.tb_dispositivo.deleteMany({ where });
      await tx.tb_consentimento.updateMany({
        where: { ...where, tb_consentimento_tipo: { consentimento_tipo_codigo: { not: 'TERMOS_USO' } } },
        data: { consentimento_status: false },
      });
      await revokeUsageAssociations(tx, id);
    });
  }

  static async findByToken(userId: number) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: userId,
        usuario_status: true,
      },
    });

    if (!user) throw new AppError('Usuário não encontrado', 404);

    return this.removePassword(user);
  }

  // helper
  private static removePassword(user: any) {
    const { usuario_senha, ...rest } = user;
    return rest;
  }
}
