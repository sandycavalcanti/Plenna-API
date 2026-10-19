import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET!;

export interface AuthRequest extends Request {
  userId?: number;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não fornecido" });
  }

  const token = authHeader.split(" ")[1];

  let userId: number;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId?: unknown };
    userId = Number(payload.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: "Token inválido" });
    }
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const user = await prisma.tb_usuario.findFirst({
      where: {
        usuario_id: userId,
        usuario_status: true,
      },
      select: {
        usuario_id: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: "Token inválido" });
    }

    req.userId = user.usuario_id;
    return next();
  } catch (err) {
    return next(err);
  }
}