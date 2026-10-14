import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/plenna_phase1_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'phase1-client';
process.env.GOOGLE_CLIENT_SECRET = 'phase1-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.test/callback';
process.env.JWT_SECRET = 'phase1-jwt-secret';
process.env.EMAIL_SYNC_ENABLED = 'false';

type HistoryRow = Record<string, any>;
type MessageRow = Record<string, any>;

let histories: HistoryRow[] = [];
let messages: MessageRow[] = [];
let nextHistoryId = 1;
let nextMessageId = 1;
let failMessageDelete = false;
let failHistoryDelete = false;

function matches(row: HistoryRow | MessageRow, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) => row[key] === expected);
}

function pick(row: HistoryRow | MessageRow, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]]),
  );
}

function sortRows(rows: HistoryRow[] | MessageRow[], orderBy: Record<string, string> | Array<Record<string, string>>) {
  const rules = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const rule of rules) {
      const [key, direction] = Object.entries(rule)[0];
      const leftValue = left[key] instanceof Date ? left[key].getTime() : left[key];
      const rightValue = right[key] instanceof Date ? right[key].getTime() : right[key];
      if (leftValue === rightValue) continue;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

function makeClient() {
  const client: any = {
    tb_historico: {
      create: async ({ data, select }: any) => {
        const row = {
          historico_id: nextHistoryId++,
          historico_nome: data.historico_nome,
          usuario_id: data.usuario_id,
          historico_data_criacao: data.historico_data_criacao,
          historico_data_modificacao: data.historico_data_modificacao,
        };
        histories.push(row);
        return pick(row, select);
      },
      findMany: async ({ where, orderBy, select }: any) => {
        const rows = histories.filter((row) => matches(row, where));
        return sortRows(rows, orderBy).map((row) => pick(row, select));
      },
      findFirst: async ({ where, select }: any) => {
        const row = histories.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      update: async ({ where, data, select }: any) => {
        const row = histories.find((candidate) => matches(candidate, where));
        if (!row) throw new Error('history not found');
        Object.assign(row, data);
        return pick(row, select);
      },
      delete: async ({ where }: any) => {
        if (failHistoryDelete) throw new Error('history delete failed');
        const index = histories.findIndex((candidate) => matches(candidate, where));
        if (index < 0) throw new Error('history not found');
        const [deleted] = histories.splice(index, 1);
        return deleted;
      },
    },
    tb_mensagem: {
      create: async ({ data, select }: any) => {
        const row = {
          mensagem_id: nextMessageId++,
          ...data,
        };
        messages.push(row);
        return pick(row, select);
      },
      findMany: async ({ where, orderBy, select }: any) => {
        const rows = messages.filter((row) => matches(row, where));
        return sortRows(rows, orderBy).map((row) => pick(row, select));
      },
      findFirst: async ({ where, orderBy, select }: any) => {
        const rows = messages.filter((row) => matches(row, where));
        const sorted = orderBy ? sortRows(rows, orderBy) : rows;
        return sorted[0] ? pick(sorted[0], select) : null;
      },
      deleteMany: async ({ where }: any) => {
        if (failMessageDelete) throw new Error('message delete failed');
        const initialLength = messages.length;
        messages = messages.filter((row) => !matches(row, where));
        return { count: initialLength - messages.length };
      },
    },
  };

  client.$transaction = async (callback: (transaction: any) => Promise<unknown>) => {
    const historySnapshot = histories.map((row) => ({ ...row }));
    const messageSnapshot = messages.map((row) => ({ ...row }));
    const historyIdSnapshot = nextHistoryId;
    const messageIdSnapshot = nextMessageId;

    try {
      return await callback(client);
    } catch (error) {
      histories = historySnapshot;
      messages = messageSnapshot;
      nextHistoryId = historyIdSnapshot;
      nextMessageId = messageIdSnapshot;
      throw error;
    }
  };
  return client;
}

const client = makeClient();
(globalThis as any).prismaRuntime = { client, pool: { end: async () => {} } };

const { ChatService } = await import('../../src/modules/chat/chat.service.js');
const { createMessageSchema, historyIdSchema } = await import('../../src/modules/chat/chat.schemas.js');

function reset() {
  histories = [];
  messages = [];
  nextHistoryId = 1;
  nextMessageId = 1;
  failMessageDelete = false;
  failHistoryDelete = false;
}

beforeEach(reset);

test('cria historico com nome e timestamps deterministas do backend', async () => {
  const result = await ChatService.createHistory(1, client);

  assert.equal(result.historico_nome, 'Nova conversa');
  assert.ok(result.historico_data_criacao instanceof Date);
  assert.ok(result.historico_data_modificacao instanceof Date);
  assert.equal(result.historico_id, 1);
});

test('lista somente historicos do usuario e ordena por modificacao e id', async () => {
  histories.push(
    { historico_id: 1, usuario_id: 1, historico_nome: 'Antigo', historico_data_criacao: new Date('2026-01-01'), historico_data_modificacao: new Date('2026-01-01') },
    { historico_id: 2, usuario_id: 1, historico_nome: 'Recente', historico_data_criacao: new Date('2026-01-02'), historico_data_modificacao: new Date('2026-02-01') },
    { historico_id: 3, usuario_id: 2, historico_nome: 'Outro usuário', historico_data_criacao: new Date('2026-03-01'), historico_data_modificacao: new Date('2026-03-01') },
    { historico_id: 4, usuario_id: 1, historico_nome: 'Mesmo instante', historico_data_criacao: new Date('2026-02-01'), historico_data_modificacao: new Date('2026-02-01') },
  );

  const result = await ChatService.listHistories(1, client);

  assert.deepEqual(result.map((history) => history.historico_id), [4, 2, 1]);
  assert.equal(result.some((history) => history.historico_id === 3), false);
});

test('usuario sem historicos recebe lista vazia', async () => {
  assert.deepEqual(await ChatService.listHistories(1, client), []);
});

test('exclui historico proprio, vazio ou com varias mensagens, sem tocar em outro historico', async () => {
  histories.push(
    { historico_id: 1, usuario_id: 1, historico_nome: 'Com mensagens', historico_data_criacao: new Date(), historico_data_modificacao: new Date() },
    { historico_id: 2, usuario_id: 1, historico_nome: 'Vazio', historico_data_criacao: new Date(), historico_data_modificacao: new Date() },
    { historico_id: 3, usuario_id: 2, historico_nome: 'Outro usuario', historico_data_criacao: new Date(), historico_data_modificacao: new Date() },
  );
  messages.push(
    { mensagem_id: 1, historico_id: 1, mensagem_remetente: false },
    { mensagem_id: 2, historico_id: 1, mensagem_remetente: true },
    { mensagem_id: 3, historico_id: 3, mensagem_remetente: false },
  );

  await ChatService.deleteHistory(1, 1, client);
  await ChatService.deleteHistory(1, 2, client);

  assert.deepEqual(histories.map((history) => history.historico_id), [3]);
  assert.deepEqual(messages.map((message) => message.historico_id), [3]);
});

test('ownership e identificador impedem exclusao indevida', async () => {
  histories.push({ historico_id: 1, usuario_id: 2, historico_nome: 'Privado', historico_data_criacao: new Date(), historico_data_modificacao: new Date() });

  await assert.rejects(
    () => ChatService.deleteHistory(1, 1, client),
    (error: any) => error.statusCode === 404,
  );
  await assert.rejects(() => ChatService.deleteHistory(1, 99, client), (error: any) => error.statusCode === 404);
  await assert.rejects(() => ChatService.deleteHistory(1, 'abc', client));
  assert.equal(histories.length, 1);
});

test('falhas de exclusao fazem rollback de mensagens e historico', async () => {
  histories.push({ historico_id: 1, usuario_id: 1, historico_nome: 'Conversa', historico_data_criacao: new Date(), historico_data_modificacao: new Date() });
  messages.push({ mensagem_id: 1, historico_id: 1, mensagem_remetente: false });

  failMessageDelete = true;
  await assert.rejects(() => ChatService.deleteHistory(1, 1, client), /message delete failed/);
  assert.equal(histories.length, 1);
  assert.equal(messages.length, 1);

  failMessageDelete = false;
  failHistoryDelete = true;
  await assert.rejects(() => ChatService.deleteHistory(1, 1, client), /history delete failed/);
  assert.equal(histories.length, 1);
  assert.equal(messages.length, 1);
});

test('abre somente historico proprio e serializa mensagens sem campos internos', async () => {
  const timestamp = new Date('2026-02-01T00:00:00.000Z');
  histories.push({
    historico_id: 10,
    usuario_id: 1,
    historico_nome: 'Conversa',
    historico_data_criacao: timestamp,
    historico_data_modificacao: timestamp,
  });
  histories.push({
    historico_id: 11,
    usuario_id: 2,
    historico_nome: 'Privado',
    historico_data_criacao: timestamp,
    historico_data_modificacao: timestamp,
  });
  messages.push(
    {
      mensagem_id: 2,
      historico_id: 10,
      mensagem_remetente: true,
      mensagem_texto: 'Resposta',
      mensagem_texto_modificado: 'interno',
      mensagem_imagem: Buffer.from('private'),
      mensagem_possui_imagem: false,
      mensagem_data_criacao: timestamp,
    },
    {
      mensagem_id: 1,
      historico_id: 10,
      mensagem_remetente: false,
      mensagem_texto: 'Pergunta',
      mensagem_texto_modificado: 'Pergunta',
      mensagem_imagem: null,
      mensagem_possui_imagem: false,
      mensagem_data_criacao: timestamp,
    },
  );

  const result = await ChatService.getHistory(1, 10, client);

  assert.deepEqual(result.mensagens.map((message) => [message.mensagem_id, message.remetente]), [[1, 'user'], [2, 'assistant']]);
  assert.equal(result.mensagens[0].texto, 'Pergunta');
  assert.equal('mensagem_texto_modificado' in result.mensagens[0], false);
  assert.equal('mensagem_imagem' in result.mensagens[0], false);
  await assert.rejects(() => ChatService.getHistory(1, 11, client), (error: any) => error.statusCode === 404);
});

test('persiste mensagem textual do usuario com remetente, texto duplicado e timestamps', async () => {
  const createdAt = new Date('2026-02-01T00:00:00.000Z');
  histories.push({
    historico_id: 1,
    usuario_id: 1,
    historico_nome: 'Nova conversa',
    historico_data_criacao: createdAt,
    historico_data_modificacao: createdAt,
  });

  const result = await ChatService.createUserMessage(1, 1, { texto: '  Olá, Plenna  ' }, client);
  const stored = messages[0];

  assert.equal(result.remetente, 'user');
  assert.equal(result.texto, 'Olá, Plenna');
  assert.equal(stored.mensagem_remetente, false);
  assert.equal(stored.mensagem_texto, 'Olá, Plenna');
  assert.equal(stored.mensagem_texto_modificado, 'Olá, Plenna');
  assert.equal(stored.mensagem_imagem, null);
  assert.equal(stored.mensagem_possui_imagem, false);
  assert.ok(stored.mensagem_data_criacao instanceof Date);
  assert.ok(histories[0].historico_data_modificacao >= createdAt);
});

test('valida texto obrigatorio, limite e identificador positivo', async () => {
  assert.throws(() => createMessageSchema.parse({ texto: '   ' }));
  assert.throws(() => createMessageSchema.parse({ texto: 'a'.repeat(4_001) }));
  assert.throws(() => historyIdSchema.parse('0'));
  assert.throws(() => historyIdSchema.parse('abc'));
});

test('mensagem de usuario em historico alheio retorna 404 sem persistir', async () => {
  histories.push({
    historico_id: 1,
    usuario_id: 2,
    historico_nome: 'Privado',
    historico_data_criacao: new Date(),
    historico_data_modificacao: new Date(),
  });

  await assert.rejects(
    () => ChatService.createUserMessage(1, 1, { texto: 'Tentativa' }, client),
    (error: any) => error.statusCode === 404,
  );
  assert.equal(messages.length, 0);
});

test('service rejeita contexto de usuario autenticado invalido', async () => {
  await assert.rejects(
    () => ChatService.listHistories(0, client),
    (error: any) => error.statusCode === 401,
  );
});
