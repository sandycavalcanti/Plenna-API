import assert from 'node:assert/strict';
import test from 'node:test';

const runtime = globalThis as typeof globalThis & { prismaRuntime?: unknown };
runtime.prismaRuntime = { client: {}, pool: { end: async () => {} } };

const { buildPlennaSystemPrompt } = await import('../../src/modules/chat/chat.prompt.js');
const { DescobertasService } = await import('../../src/modules/analise/descobertas.service.js');
const { consultarRespostaIndicadores } = await import('../../src/modules/chat/chat.indicadores.js');

test('contexto temporal usa o fuso de negócio e resolve viradas de dia, mês e ano', () => {
  const beforeMidnight = buildPlennaSystemPrompt(new Date('2026-12-01T02:59:59.000Z'));
  assert.match(beforeMidnight, /Data atual no fuso America\/Sao_Paulo: 2026-11-30/);
  assert.match(beforeMidnight, /Periodo atual: 2026-11\. Periodo anterior: 2026-10/);

  const afterMidnight = buildPlennaSystemPrompt(new Date('2026-12-01T03:00:00.000Z'));
  assert.match(afterMidnight, /Data atual no fuso America\/Sao_Paulo: 2026-12-01/);
  assert.match(afterMidnight, /Periodo atual: 2026-12\. Periodo anterior: 2026-11/);

  const newYear = buildPlennaSystemPrompt(new Date('2027-01-01T03:00:00.000Z'));
  assert.match(newYear, /Data atual no fuso America\/Sao_Paulo: 2027-01-01/);
  assert.match(newYear, /Periodo atual: 2027-01\. Periodo anterior: 2026-12/);
});

test('contexto temporal orienta expressões relativas e limita períodos não suportados', () => {
  const prompt = buildPlennaSystemPrompt(new Date('2026-11-08T15:00:00.000Z'));
  for (const expression of [
    'este mes', 'esse mes', 'mes atual', 'atualmente', 'ate agora',
    'mes passado', 'mes anterior', 'no anterior', 'hoje', 'neste ano',
  ]) {
    assert.match(prompt, new RegExp(expression));
  }
  assert.match(prompt, /periodo explicito no usuario.*prioridade/);
  assert.match(prompt, /nao invente um total/);
});

test('fluxo determinístico usa o mês do backend e preserva período explícito', async () => {
  const original = DescobertasService.consultar;
  const periods: string[] = [];
  DescobertasService.consultar = async (_userId: number, periodo: string) => {
    periods.push(periodo);
    return {
      versaoContrato: 1,
      periodo,
      referenciaTemporal: 'America/Sao_Paulo',
      financeiro: null,
      descobertas: [],
      avaliacaoAutomatica: null,
      historico: null,
      eventos: { disponivel: false },
      indisponiveis: ['FINANCEIRO', 'HISTORICO'],
    } as any;
  };

  try {
    const requestNow = new Date('2027-01-01T02:59:59.000Z');
    await consultarRespostaIndicadores(7, 'Quanto gastei?', requestNow);
    await consultarRespostaIndicadores(7, 'Quanto gastei em 2026-11?', requestNow);
    assert.deepEqual(periods, ['2026-12', '2026-11']);
  } finally {
    DescobertasService.consultar = original;
  }
});
