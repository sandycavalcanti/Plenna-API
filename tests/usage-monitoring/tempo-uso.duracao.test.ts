import assert from 'node:assert/strict';
import test from 'node:test';
import { minutosParaSegundos, segundosDoRegistro, duracaoLegada } from '../../src/modules/tempo-uso/tempo-uso.duracao.js';
test('conversão explícita, arredondamento e precisão de compatibilidade', () => {
  assert.equal(minutosParaSegundos(1.5), 90);
  assert.equal(minutosParaSegundos(1.025), 62);
  assert.equal(minutosParaSegundos(0.025), 2);
  assert.equal(minutosParaSegundos(0.01), 1);
  assert.deepEqual(duracaoLegada(1), { tempo_uso_duracao_segundos: 1, tempo_uso_minutos: 0.02 });
});
for (const valor of [0, -1, 0.001, NaN, Infinity, null, 1e12]) test(`rejeita duração inválida ${valor}`, () => {
  assert.throws(() => minutosParaSegundos(valor));
});
test('leitura usa segundos; legado é convertido sem escrita', () => {
  assert.equal(segundosDoRegistro({ tempo_uso_duracao_segundos: 61, tempo_uso_minutos: 99 }), 61);
  assert.equal(segundosDoRegistro({ tempo_uso_duracao_segundos: null, tempo_uso_minutos: '1.5' }), 90);
  assert.equal(segundosDoRegistro({ tempo_uso_duracao_segundos: null, tempo_uso_minutos: null }), null);
});
