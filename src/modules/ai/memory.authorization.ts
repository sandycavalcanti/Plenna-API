import {
  CONSENTIMENTO_CODIGOS,
} from '../consentimento/consentimento.constants.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import type { MemoryAuthorizationContext } from './memory.contracts.js';

export async function resolveMemoryAuthorization(
  usuarioId: number,
): Promise<MemoryAuthorizationContext> {
  const consentimentoAtivo = await ConsentimentoService.temConsentimentoAtivo(
    usuarioId,
    CONSENTIMENTO_CODIGOS.IA_MEMORIA,
  );

  return {
    usuario_id: usuarioId,
    consentimento_memoria_ativo: consentimentoAtivo,
    pode_ler: consentimentoAtivo,
    pode_escrever: consentimentoAtivo,
    // Exclusão própria permanece disponível para limpeza após revogação.
    pode_excluir: true,
  };
}
