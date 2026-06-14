import { prisma } from '../../lib/prisma.js';
export class FormaPagamentoService {
    static async findAll() {
        return prisma.tb_forma_pagamento.findMany({
            orderBy: { forma_pagamento_nome: 'asc' },
        });
    }
}
