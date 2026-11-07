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
  static async register(data: {
    email: string;
    senha: string;
    nome: string;
    aceitouTermos: true;
  }) {
    const userExists = await prisma.tb_usuario.findUnique({
      where: { usuario_email: data.email },
    });

    if (userExists) throw new AppError("Email já cadastrado", 409);

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
    });
  }

  static async login(email: string, password: string) {
    const user = await prisma.tb_usuario.findUnique({
      where: { usuario_email: email },
      include: {
        _count: {
          select: { tb_preferencia: true },
        },
      },
    });

   if (!user || user.usuario_status !== true) {
   throw new AppError("Credenciais inválidas", 401);
}

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
    const user = await prisma.tb_usuario.findUnique({
      where: { usuario_email: email },
    });

    if (!user || user.usuario_status === false) return;

    const codigo = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const token = crypto.randomBytes(32).toString('hex');
    const codigoHash = `${await bcrypt.hash(codigo, 10)}|${crypto.createHash('sha256').update(token).digest('hex')}`;
    const link = new URL(process.env.PASSWORD_RESET_URL || 'plenna://reset-password');
    if (!(link.protocol === 'plenna:' || link.protocol === 'https:') || link.username || link.password) {
      throw new Error('URL de redefinição não configurada corretamente');
    }
    link.searchParams.set('email', email);
    link.searchParams.set('token', token);
    const expiraEm = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

    const registro = await prisma.$transaction(async (tx) => {
      // Serializa emissão e conclusão por conta, inclusive entre instâncias serverless.
      await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${user.usuario_id} FOR UPDATE`;
      const ultimoRegistro = await tx.tb_redefinicao_senha.findFirst({
        where: { usuario_id: user.usuario_id },
        orderBy: { redefinicao_senha_data_criacao: "desc" },
      });
      if (ultimoRegistro && ultimoRegistro.redefinicao_senha_data_criacao.getTime() > Date.now() - RESET_CODE_RESEND_SECONDS * 1000) return null;
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
        `<p>Olá!</p>
         <p><a href="${link.toString().replace(/&/g, '&amp;')}">Redefinir minha senha no aplicativo Plenna</a></p>
         <p>Seu código para redefinir a senha do Plenna é:</p>
         <p style="font-size:24px; font-weight:bold; letter-spacing:4px;">${codigo}</p>
         <p>Esse código expira em ${RESET_CODE_TTL_MINUTES} minutos. Se você não pediu essa redefinição, ignore este e-mail.</p>`,
      );
    } catch (error) {
      logSeguro('redefinicao_smtp_falhou', error, correlacao);
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
    const user = await prisma.tb_usuario.findUnique({
      where: { usuario_email: email },
    });

    if (!user || user.usuario_status === false) throw new AppError("Código inválido ou expirado", 400);

    const registro = await prisma.tb_redefinicao_senha.findFirst({
      where: { usuario_id: user.usuario_id, redefinicao_senha_usado: false },
      orderBy: { redefinicao_senha_data_criacao: "desc" },
    });

    if (!registro) throw new AppError("Código inválido ou expirado", 400);

    if (registro.redefinicao_senha_expira_em <= new Date()) {
      throw new AppError("Código inválido ou expirado", 400);
    }

    if (registro.redefinicao_senha_tentativas >= RESET_CODE_MAX_ATTEMPTS) {
      throw new AppError("Número máximo de tentativas excedido. Solicite um novo código.", 429);
    }

    // Reserva uma tentativa antes da comparação para limitar verificações concorrentes.
    const tentativa = await prisma.tb_redefinicao_senha.updateMany({
      where: {
        redefinicao_senha_id: registro.redefinicao_senha_id,
        redefinicao_senha_usado: false,
        redefinicao_senha_expira_em: { gt: new Date() },
        redefinicao_senha_tentativas: { lt: RESET_CODE_MAX_ATTEMPTS },
      },
      data: { redefinicao_senha_tentativas: { increment: 1 } },
    });
    if (tentativa.count !== 1) throw new AppError("Código inválido ou expirado", 400);
    const [hashCodigo, hashToken] = registro.redefinicao_senha_codigo_hash.split('|');
    const match = /^[a-f0-9]{64}$/.test(codigo)
      ? Boolean(hashToken && /^[a-f0-9]{64}$/.test(hashToken) && crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(codigo).digest('hex')), Buffer.from(hashToken)))
      : await bcrypt.compare(codigo, hashCodigo);
    if (!match) throw new AppError("Código inválido ou expirado", 400);

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
      await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${user.usuario_id} FOR UPDATE`;
      const consumed = await tx.tb_redefinicao_senha.updateMany({
        where: {
          redefinicao_senha_id: registro.redefinicao_senha_id,
          redefinicao_senha_usado: false,
          redefinicao_senha_expira_em: { gt: new Date() },
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
