import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../errors/AppError.js";

const JWT_SECRET = process.env.JWT_SECRET!;

export class AuthService {
  static async register(data: {
    email: string;
    senha: string;
    nome: string;
  }) {
    const userExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email },
    });

    if (userExists) throw new AppError("Email já cadastrado", 400);

    const hash = await bcrypt.hash(data.senha, 10);
    
    const user = await prisma.tb_usuario.create({
      data: {
        usuario_email: data.email,
        usuario_senha: hash,
        usuario_nome: data.nome,
      },
    });

    const usuario_id = user.usuario_id;

    return user;
  }

  static async login(email: string, password: string) {
    const user = await prisma.tb_usuario.findUnique({
      where: { usuario_email: email },
    });

    if (!user) throw new AppError("Credenciais inválidas", 401);

    const match = await bcrypt.compare(password, user.usuario_senha);
    if (!match) throw new AppError("Credenciais inválidas", 401);

    const token = jwt.sign({ userId: user.usuario_id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return { token };
  }
}
