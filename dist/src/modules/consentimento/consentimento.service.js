import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { CONSENTIMENTO_CODIGOS } from './consentimento.constants.js';
export class ConsentimentoService {
    static async findTipos() {
        return prisma.tb_consentimento_tipo.findMany({
            orderBy: { consentimento_tipo_id: 'asc' },
        });
    }
    static async findTipoPorCodigo(codigo) {
        const tipo = await prisma.tb_consentimento_tipo.findUnique({
            where: { consentimento_tipo_codigo: codigo },
        });
        if (!tipo)
            throw new AppError('Tipo de consentimento não encontrado', 500);
        return tipo;
    }
    static async findAllByUserId(userId) {
        return prisma.tb_consentimento.findMany({
            where: { usuario_id: userId },
            include: { tb_consentimento_tipo: true },
        });
    }
    static async registrar(userId, codigo, status) {
        return prisma.$transaction((tx) => this.registrarComClient(tx, userId, codigo, status));
    }
    static async registrarBulk(userId, itens) {
        return prisma.$transaction(async (tx) => {
            const resultados = [];
            for (const item of itens) {
                resultados.push(await this.registrarComClient(tx, userId, item.consentimentoTipoCodigo, item.status));
            }
            return resultados;
        });
    }
    static async temConsentimentoAtivo(userId, codigo) {
        const consentimento = await prisma.tb_consentimento.findFirst({
            where: {
                usuario_id: userId,
                consentimento_status: true,
                tb_consentimento_tipo: { consentimento_tipo_codigo: codigo },
            },
            select: { consentimento_id: true },
        });
        return consentimento !== null;
    }
    static async conceder(userId, codigo) {
        return this.registrar(userId, codigo, true);
    }
    static async bloquearUsuario(tx, userId) {
        const usuarios = await tx.$queryRaw `SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${userId} FOR UPDATE`;
        if (usuarios.length !== 1)
            throw new AppError('Usuário não encontrado', 404);
    }
    static async registrarComClient(tx, userId, codigo, status, conexaoConfirmada = false) {
        await this.bloquearUsuario(tx, userId);
        if (codigo === CONSENTIMENTO_CODIGOS.EMAIL && status && !conexaoConfirmada) {
            throw new AppError('Conclua a conexão de e-mail para autorizar a captura', 409);
        }
        const tipo = await tx.tb_consentimento_tipo.findUnique({
            where: { consentimento_tipo_codigo: codigo },
        });
        if (!tipo)
            throw new AppError('Tipo de consentimento não encontrado', 404);
        if (!status && codigo === CONSENTIMENTO_CODIGOS.TERMOS_USO) {
            throw new AppError('Os termos de uso não podem ser revogados enquanto a conta estiver ativa', 400);
        }
        const existente = await tx.tb_consentimento.findUnique({ where: { usuario_tipo_unique: { usuario_id: userId, consentimento_tipo_id: tipo.consentimento_tipo_id } } });
        const consentimento = existente?.consentimento_status === status ? existente : await tx.tb_consentimento.upsert({
            where: {
                usuario_tipo_unique: {
                    usuario_id: userId,
                    consentimento_tipo_id: tipo.consentimento_tipo_id,
                },
            },
            update: {
                consentimento_status: status,
                consentimento_data_criacao: new Date(),
            },
            create: {
                usuario_id: userId,
                consentimento_tipo_id: tipo.consentimento_tipo_id,
                consentimento_status: status,
                consentimento_data_criacao: new Date(),
            },
        });
        if (!status && codigo === CONSENTIMENTO_CODIGOS.EMAIL) {
            await tx.tb_oauth_tentativa.updateMany({
                where: { usuario_id: userId, oauth_provedor: { in: ['GMAIL', 'OUTLOOK'] }, oauth_status: { in: ['PENDENTE', 'PROCESSANDO'] } },
                data: { oauth_status: 'CANCELADA', oauth_finalizada_em: new Date() },
            });
            await tx.tb_integracao.deleteMany({ where: { usuario_id: userId, integracao_provedor: { in: ['GMAIL', 'OUTLOOK'] } } });
        }
        return consentimento;
    }
}
