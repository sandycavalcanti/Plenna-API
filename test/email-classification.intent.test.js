import test from 'node:test';
import assert from 'node:assert/strict';

const { EmailClassificationEngine } = await import('../dist/src/modules/email/classification.engine.js');

function message(subject, from, snippet = '', labelIds = []) {
  return { id: subject, subject, from, snippet, labelIds };
}

test('Classroom e professor sao ignorados', () => {
  assert.equal(EmailClassificationEngine.classify(message('Novo comunicado: alunos, segue o simulado', 'Professor (Sala de Aula) <no-reply@classroom.google.com>')).outcome, 'IGNORAR');
});

test('GitHub security advisory e ignorado', () => {
  assert.equal(EmailClassificationEngine.classify(message('A security advisory affects repositories', 'GitHub <notifications@github.com>')).outcome, 'IGNORAR');
});

test('changelog tecnico e ignorado mesmo com label de promocoes', () => {
  assert.equal(EmailClassificationEngine.classify(message('Neon Changelog: backend products get faster', 'Neon <changelog@neon.tech>', '', ['CATEGORY_PROMOTIONS'])).outcome, 'IGNORAR');
});

test('newsletter institucional sem oferta e ignorada', () => {
  assert.equal(EmailClassificationEngine.classify(message('Como conectamos legado e automacao', 'Empresa via LinkedIn <newsletters-noreply@linkedin.com>')).outcome, 'IGNORAR');
});

test('SHEIN, Marisa e Alura com intencao comercial sao propaganda', () => {
  assert.equal(EmailClassificationEngine.classify(message('Oferta SHEIN com desconto', 'SHEIN <promo@shein.com>', 'Cupom para comprar')).outcome, 'PROPAGANDA');
  assert.equal(EmailClassificationEngine.classify(message('Produtos Marisa em oferta', 'Marisa <ofertas@marisa.com.br>')).outcome, 'PROPAGANDA');
  assert.equal(EmailClassificationEngine.classify(message('Desconto para matricula', 'Alura <ofertas@alura.com.br>')).outcome, 'PROPAGANDA');
});

test('office nao e interpretado como OFF promocional', () => {
  assert.notEqual(EmailClassificationEngine.classify(message('Atualizacao do Office', 'Microsoft <news@microsoft.com>')).outcome, 'PROPAGANDA');
});

test('preco isolado e label de promocoes nao confirmam propaganda', () => {
  assert.equal(EmailClassificationEngine.classify(message('Atualizacao da conta R$ 99,90', 'Servico <info@service.com>', 'Informacoes da conta')).outcome, 'AMBIGUA');
  assert.equal(EmailClassificationEngine.classify(message('Boletim semanal', 'Newsletter <news@service.com>', 'Conteudo informativo', ['CATEGORY_PROMOTIONS'])).outcome, 'AMBIGUA');
});
