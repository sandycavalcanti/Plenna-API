import bcrypt from 'bcrypt';
import { prisma } from '../../lib/prisma.js';
import { CreateUserDTO, UpdateUserDTO } from './user.schemas.js';

const SALT_ROUNDS = 10;

export class UsersService {
  // CREATE
  static async create(data: CreateUserDTO) {
    // Verificar se o email já existe
    const emailExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email },
    });
    if (emailExists) {
      throw new Error('Email já cadastrado');
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

    if (!user) throw new Error('Usuário não encontrado');

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

    if (!user) throw new Error('Usuário não encontrado');

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

    const updated = await prisma.tb_usuario.update({
      where: { usuario_id: id },
      data: updateData,
    });

    return this.removePassword(updated);
  }

  // DELETE (soft delete)
  static async delete(id: number) {
    await this.findById(id);

    await prisma.tb_usuario.update({
      where: { usuario_id: id },
      data: {
        usuario_status: false,
      },
    });
  }

  static async findUserByToken(userId: number) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: userId,
        usuario_status: true,
      },
    });

    if (!user) throw new Error('Usuário não encontrado');

    return this.removePassword(user);
  }

  // helper
  private static removePassword(user: any) {
    const { usuario_senha, ...rest } = user;
    return rest;
  }
}
