import { AppError } from '../../errors/AppError.js';
import { env } from '../../lib/env.js';
import { CodexLocalProvider } from './codex-local.provider.js';
import type { AIProvider } from './ai-provider.js';
import { RequestyProvider } from './requesty.provider.js';

export function createAIProvider(): AIProvider | null {
  switch (env.aiProvider) {
    case 'requesty':
      return env.requestyApiKey ? new RequestyProvider() : null;
    case 'codex_local':
      if (env.isProduction) {
        throw new AppError('AI_PROVIDER=codex_local não é permitido em produção', 500);
      }
      return new CodexLocalProvider();
    default:
      throw new AppError(`Provider de IA inválido: ${env.aiProvider}`, 500);
  }
}
