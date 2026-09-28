// Banco simulado; serialização em JS NÃO comprova locks PostgreSQL.
import assert from 'node:assert/strict';
import type { TempoUsoTransactionRunner } from '../../src/modules/tempo-uso/tempo-uso.sync.js';
export function bancoSimulado() {
  let registros: any[] = [];
  let autorizado = true;
  let fila = Promise.resolve();
  const chamadas: string[] = [];
  let falharPackage = '';
  const tx: any = {
    $queryRaw: async (sql: TemplateStringsArray, usuario: number) => {
      chamadas.push('lock');
      assert.match(sql.join('?'), /tb_usuario.*FOR UPDATE/);
      return [{ usuario_id: usuario }];
    },
    tb_consentimento: { findFirst: async (args: any) => {
      chamadas.push('consentimento');
      assert.equal(args.where.tb_consentimento_tipo.consentimento_tipo_codigo, 'MONITORAMENTO_TEMPO_USO');
      return autorizado ? { consentimento_id: 1 } : null;
    } },
    tb_tempo_uso: {
      findMany: async (args: any) => {
        chamadas.push('conflitos');
        return registros.filter(r => r.usuario_id === args.where.usuario_id && (!args.where.OR || args.where.OR.some((f: any) =>
          r.tempo_uso_package_id === f.tempo_uso_package_id && r.tempo_uso_inicio < f.tempo_uso_inicio.lt && r.tempo_uso_fim > f.tempo_uso_fim.gt)));
      },
      findFirst: async ({ where }: any) => registros.find(r => r.usuario_id === where.usuario_id && r.tempo_uso_id === where.tempo_uso_id) ?? null,
      create: async ({ data }: any) => {
        chamadas.push('create');
        const row = { tempo_uso_id: registros.length + 1, tempo_uso_inicio: null, tempo_uso_minutos: null,
          tempo_uso_data: null, tempo_uso_duracao_segundos: null, tempo_uso_origem: 'LEGADO', ...data };
        registros.push(row); return row;
      },
      update: async ({ where, data }: any) => {
        chamadas.push('update');
        const row = registros.find(r => r.tempo_uso_id === where.tempo_uso_id);
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return row;
      },
      upsert: async ({ where, create, update }: any) => {
        chamadas.push('upsert');
        if (create.tempo_uso_package_id === falharPackage) throw new Error('Falha simulada');
        const k = where.tempo_uso_usuario_package_periodo_unique;
        const row = registros.find(r => r.usuario_id === k.usuario_id && r.tempo_uso_package_id === k.tempo_uso_package_id &&
          +r.tempo_uso_inicio === +k.tempo_uso_inicio && +r.tempo_uso_fim === +k.tempo_uso_fim);
        if (row) Object.assign(row, update); else registros.push({ tempo_uso_id: registros.length + 1, ...create });
      },
    },
  };
  const client: any = { ...tx, $transaction: (fn: any) => {
    const exec = async () => {
      const copia = structuredClone(registros);
      try { return await fn(tx); } catch (e) { registros = copia; throw e; }
    };
    const atual = fila.then(exec); fila = atual.catch(() => undefined); return atual;
  } };
  return { client, runner: client as TempoUsoTransactionRunner, chamadas,
    registros: () => registros, seed: (r: any) => registros.push(r),
    consentir: (v: boolean) => { autorizado = v; }, falhar: (p: string) => { falharPackage = p; } };
}
export function fotografia(packageId = 'com.exemplo.loja') {
  return { packageId, nomeApp: 'Loja de teste', inicio: new Date('2026-09-11T03:00:00Z'),
    fim: new Date('2026-09-12T03:00:00Z'), duracaoSegundos: 930,
    dataLocal: new Date('2026-09-11T00:00:00Z'), timezone: 'America/Sao_Paulo' };
}
