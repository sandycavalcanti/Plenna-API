import bcrypt from "bcrypt";
import { prisma } from "../../lib/prisma.js";
import { CreateUserDTO, UpdateUserDTO } from "./user.schemas.js";

const SALT_ROUNDS = 10;

export class UsersService {

  // CREATE
  static async create(data: CreateUserDTO) {
    // Verificar se o email já existe
    const emailExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email }
    });
    if (emailExists) {
      throw new Error("Email já cadastrado");
    }
    // Hash da senha
    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
    const user = await prisma.tb_usuario.create({
      data: {
        usuario_email: data.email,
        usuario_senha: passwordHash,
        usuario_nome: data.name,
        usuario_status: true,
        usuario_created_at: new Date(),
        usuario_updated_at: new Date()
      }
    });
    return this.removePassword(user);
  }

  // LIST
  static async findAll() {
    const users = await prisma.tb_usuario.findMany({
      where: { usuario_deleted_at: null }
    });
    return users.map(this.removePassword);
  }

  // GET BY ID
  static async findById(id: number) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: id,
        usuario_deleted_at: null
      }
    });

    if (!user) throw new Error("Usuário não encontrado");

    return this.removePassword(user);
  }

  // GET BY EMAIL
  static async findByEmail(email: string) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_email: email,
        usuario_deleted_at: null
      }
    });

    if (!user) throw new Error("Usuário não encontrado");

    return this.removePassword(user);
  }

  // UPDATE
  static async update(id: number, data: UpdateUserDTO) {
    await this.findById(id);

    const updated = await prisma.tb_usuario.update({
      where: { usuario_id: id },
      data: {
        usuario_nome: data.name,
        usuario_status: data.status,
        usuario_updated_at: new Date()
      }
    });

    return this.removePassword(updated);
  }

  // DELETE (soft delete)
  static async delete(id: number) {
    await this.findById(id);

    await prisma.tb_usuario.update({
      where: { usuario_id: id },
      data: {
        usuario_deleted_at: new Date()
      }
    });
  }
  
  static async findUserByToken(userId: number) {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: userId,
        usuario_deleted_at: null
      }
    });

    if (!user) throw new Error("Usuário não encontrado");

    return this.removePassword(user);
  }

  // helper
  private static removePassword(user: any) {
    const { usuario_senha, ...rest } = user;
    return rest;
  }
}