import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET!;

export class AuthService {

  static async register(data: {
    email: string;
    password: string;
    name: string;
  }) {
    const userExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email }
    });

    if (userExists) throw new Error("Email já cadastrado");

    const hash = await bcrypt.hash(data.password, 10);

    const user = await prisma.tb_usuario.create({
      data: {
        usuario_email: data.email,
        usuario_senha: hash,
        usuario_nome: data.name,
        usuario_status: true,
        usuario_created_at: new Date(),
        usuario_updated_at: new Date()
      }
    });

    return user;
  }

  static async login(email: string, password: string) {
    const user = await prisma.tb_usuario.findUnique({
      where: { usuario_email: email }
    });

    if (!user) throw new Error("Credenciais inválidas");

    const match = await bcrypt.compare(password, user.usuario_senha);
    if (!match) throw new Error("Credenciais inválidas");

    const token = jwt.sign(
      { userId: user.usuario_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return { token };
  }
}