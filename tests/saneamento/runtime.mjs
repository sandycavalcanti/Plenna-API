// Runtime inteiramente simulado: nenhum Pool, socket SMTP ou conexão Neon.
import { randomBytes } from 'node:crypto';
process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.RATE_LIMIT_HMAC_KEY = randomBytes(32).toString('hex');
process.env.SMTP_HOST = 'smtp.invalid';
process.env.SMTP_USER = 'teste@example.invalid';
process.env.SMTP_PASS = randomBytes(32).toString('hex');
delete process.env.VERCEL;
const nomes = ['tb_usuario', 'tb_redefinicao_senha', 'tb_oauth_tentativa', 'tb_integracao', 'tb_consentimento', 'tb_consentimento_tipo'];
const metodos = ['findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'deleteMany', 'upsert'];
const inesperado = async () => { throw new Error('Operação não simulada'); };
export const client = Object.fromEntries(nomes.map(nome => [nome, Object.fromEntries(metodos.map(m => [m, inesperado]))]));
client.$transaction = async fn => fn(client);
client.$queryRaw = inesperado;
client.$executeRaw = inesperado;
client.$disconnect = async () => {};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };
