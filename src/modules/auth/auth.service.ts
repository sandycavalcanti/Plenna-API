import { Prisma } from '@prisma/client';
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../errors/AppError.js";
import { sendMail } from "../../lib/mailer.js";
import { logSeguro } from '../../utils/logSeguro.js';
import { ConsentimentoService } from "../consentimento/consentimento.service.js";
import { CONSENTIMENTO_CODIGOS } from "../consentimento/consentimento.constants.js";

const JWT_SECRET = process.env.JWT_SECRET!;

const RESET_CODE_TTL_MINUTES = 15;
const RESET_CODE_MAX_ATTEMPTS = 5;
const RESET_CODE_RESEND_SECONDS = 60;

export class AuthService {
  private static async findActiveAccount(email: string) {
    const matches = await prisma.$queryRaw<{ usuario_id: number }[]>`
      SELECT usuario_id FROM public.tb_usuario
      WHERE lower(usuario_email) = lower(${email}) AND usuario_status = true
      LIMIT 2
    `;
    // A case-insensitive lookup must never select between different accounts.
    if (matches.length !== 1) return null;
    return prisma.tb_usuario.findFirst({
      where: { usuario_id: matches[0]!.usuario_id, usuario_status: true },
      include: { _count: { select: { tb_preferencia: true } } },
    });
  }

  static async register(data: {
    email: string;
    senha: string;
    nome: string;
    aceitouTermos: true;
  }) {
    const matches = await prisma.$queryRaw<{ usuario_id: number }[]>`
      SELECT usuario_id FROM public.tb_usuario
      WHERE lower(usuario_email) = lower(${data.email})
      LIMIT 1
    `;

    if (matches.length) throw new AppError("Email já cadastrado", 409);

    const hash = await bcrypt.hash(data.senha, 10);
    
    const tipoTermos = await ConsentimentoService.findTipoPorCodigo(CONSENTIMENTO_CODIGOS.TERMOS_USO);

    return prisma.$transaction(async (tx) => {
      const user = await tx.tb_usuario.create({
        data: {
          usuario_email: data.email,
          usuario_senha: hash,
          usuario_nome: data.nome,
        },
      });

      await tx.tb_consentimento.create({
        data: {
          usuario_id: user.usuario_id,
          consentimento_tipo_id: tipoTermos.consentimento_tipo_id,
          consentimento_status: true,
          consentimento_data_criacao: new Date(),
        },
      });

      const { usuario_senha, ...usuarioSeguro } = user;
      return usuarioSeguro;
    }).catch(error => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError("Email já cadastrado", 409);
      }
      throw error;
    });
  }

  static async login(email: string, password: string) {
    const user = await this.findActiveAccount(email);
    if (!user) throw new AppError("Credenciais inválidas", 401);

    const match = await bcrypt.compare(password, user.usuario_senha);
    if (!match) throw new AppError("Credenciais inválidas", 401);

    const token = jwt.sign({ userId: user.usuario_id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    const onboardingCompleto =
      Number(user.usuario_meta_valor_mensal) > 0 && user._count.tb_preferencia > 0;

    return { token, onboardingCompleto };
  }

  // Passo 1 da tela de recuperação: gera e envia o código por e-mail.
  // Não revela se o e-mail existe ou não, para evitar enumeração de usuários.
  static async forgotPassword(email: string) {
    const correlacao = crypto.randomUUID();
    const user = await this.findActiveAccount(email);

    if (!user) return;

    const codigo = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const codigoHash = await bcrypt.hash(codigo, 10);
    const expiraEm = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

    const registro = await prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, user.usuario_id);
      const ultimoRegistro = await tx.tb_redefinicao_senha.findFirst({
        where: { usuario_id: user.usuario_id },
        orderBy: { redefinicao_senha_data_criacao: "desc" },
      });
      if (ultimoRegistro &&
          ultimoRegistro.redefinicao_senha_data_criacao.getTime() > Date.now() - RESET_CODE_RESEND_SECONDS * 1000) {
        return null;
      }
      await tx.tb_redefinicao_senha.updateMany({
        where: { usuario_id: user.usuario_id, redefinicao_senha_usado: false },
        data: { redefinicao_senha_usado: true },
      });

      return tx.tb_redefinicao_senha.create({
        data: {
          usuario_id: user.usuario_id,
          redefinicao_senha_codigo_hash: codigoHash,
          redefinicao_senha_expira_em: expiraEm,
        },
      });
    });

    if (!registro) return;

    try {
      await sendMail(
        user.usuario_email,
        "Código de redefinição de senha — Plenna",
        `<p>Olá, ${user.usuario_nome}!</p>
         <p>Seu código para redefinir a senha do Plenna é:</p>
         <p style="font-size:24px; font-weight:bold; letter-spacing:4px;">${codigo}</p>
         <p>Esse código expira em ${RESET_CODE_TTL_MINUTES} minutos. Se você não pediu essa redefinição, ignore este e-mail.</p>`,
      );
    } catch (error) {
      logSeguro('redefinicao_smtp_falhou', error, correlacao, { etapa: 'smtp.sendMail' });
      try {
        await prisma.tb_redefinicao_senha.update({
          where: { redefinicao_senha_id: registro.redefinicao_senha_id },
          data: { redefinicao_senha_usado: true },
        });
      } catch (invalidacaoError) {
        logSeguro('redefinicao_invalidacao_falhou', invalidacaoError, correlacao);
      }
    }
  }

  // Busca o código pendente mais recente do usuário e valida expiração, uso e tentativas.
  // Usado tanto no passo 2 (verificar) quanto no passo 3 (trocar a senha).
  private static async findValidResetCode(email: string, codigo: string) {
    const user = await this.findActiveAccount(email);

    if (!user) throw new AppError("Código inválido ou expirado", 400);

    const registro = await prisma.tb_redefinicao_senha.findFirst({
      where: { usuario_id: user.usuario_id, redefinicao_senha_usado: false },
      orderBy: { redefinicao_senha_data_criacao: "desc" },
    });

    if (!registro) throw new AppError("Código inválido ou expirado", 400);

    if (registro.redefinicao_senha_expira_em < new Date()) {
      throw new AppError("Código inválido ou expirado", 400);
    }

    if (registro.redefinicao_senha_tentativas >= RESET_CODE_MAX_ATTEMPTS) {
      throw new AppError("Número máximo de tentativas excedido. Solicite um novo código.", 429);
    }

    const match = await bcrypt.compare(codigo, registro.redefinicao_senha_codigo_hash);

    if (!match) {
      await prisma.tb_redefinicao_senha.updateMany({
        where: {
          redefinicao_senha_id: registro.redefinicao_senha_id,
          redefinicao_senha_usado: false,
          redefinicao_senha_tentativas: { lt: RESET_CODE_MAX_ATTEMPTS },
        },
        data: { redefinicao_senha_tentativas: { increment: 1 } },
      });
      throw new AppError("Código inválido ou expirado", 400);
    }

    return { user, registro };
  }

  // Passo 2 da tela: só confirma se o código bate, sem alterar nada ainda.
  static async verifyResetCode(email: string, codigo: string) {
    await this.findValidResetCode(email, codigo);
    return { valido: true };
  }

  // Passo 3 da tela: revalida o código e troca a senha na mesma transação
  // que marca o código como usado, para não permitir reuso.
  static async resetPassword(email: string, codigo: string, novaSenha: string) {
    const { user, registro } = await this.findValidResetCode(email, codigo);

    const hash = await bcrypt.hash(novaSenha, 10);

    await prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, user.usuario_id);
      const consumed = await tx.tb_redefinicao_senha.updateMany({
        where: {
          redefinicao_senha_id: registro.redefinicao_senha_id,
          redefinicao_senha_usado: false,
          redefinicao_senha_expira_em: { gt: new Date() },
          redefinicao_senha_tentativas: { lt: RESET_CODE_MAX_ATTEMPTS },
        },
        data: { redefinicao_senha_usado: true },
      });

      if (consumed.count !== 1) {
        throw new AppError("Código inválido ou expirado", 400);
      }

      await tx.tb_usuario.update({
        where: { usuario_id: user.usuario_id },
        data: { usuario_senha: hash },
      });
    });
  }
}
