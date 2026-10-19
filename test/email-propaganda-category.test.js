import test from 'node:test';
import assert from 'node:assert/strict';

const { validatePropagationCategoryId } = await import('../dist/src/modules/email/email-sync.service.js');

const categories = [
  { categoryId: 10, categoryName: 'Roupas e calcados' },
  { categoryId: 21, categoryName: 'Assinaturas e servicos digitais' },
  { categoryId: 35, categoryName: 'Educacao' },
];

test('categoryId valido e aceito sem depender do nome', () => {
  assert.equal(validatePropagationCategoryId(10, categories), 10);
  assert.equal(validatePropagationCategoryId(21, categories), 21);
  assert.equal(validatePropagationCategoryId(35, categories), 35);
});

test('categoryId inexistente ou nulo vira null', () => {
  assert.equal(validatePropagationCategoryId(999, categories), null);
  assert.equal(validatePropagationCategoryId(null, categories), null);
});

test('IDs diferentes entre ambientes continuam validos pela lista carregada', () => {
  assert.equal(validatePropagationCategoryId(77, [{ categoryId: 77, categoryName: 'Roupas e calcados' }]), 77);
});
