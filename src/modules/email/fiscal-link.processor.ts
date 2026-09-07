import { env } from '../../lib/env.js';
import type { EmailLink } from './email-contracts.js';
import { DanfePdfParseError, parseDanfePdf } from './danfe.pdf.parser.js';
import { getFiscalLinkCandidates } from './fiscal-link.candidate.js';
import { downloadFiscalDocument, isExpectedFiscalLinkError } from './fiscal-document.downloader.js';
import { NFeXmlParseError, parseNFeXml } from './nfe.parser.js';
import type { FiscalSourceResults } from './purchase-source.merge.js';

/**
 * Processa links somente depois da compra estar classificada. Cada documento
 * valido entra na mesma estrutura dos anexos, para manter uma unica politica
 * de merge e isolar falhas esperadas de um link opcional.
 */
export async function processFiscalLinks(links: EmailLink[]): Promise<FiscalSourceResults> {
  const results: FiscalSourceResults = { nfe: [], danfe: [] };
  const candidates = getFiscalLinkCandidates(links, env.emailFiscalLinkMaxPerEmail);

  for (const candidate of candidates) {
    try {
      const document = await downloadFiscalDocument(
        candidate.href,
        env.emailFiscalLinkMaxBytes,
        env.emailFiscalLinkTimeoutMs,
        env.emailFiscalLinkMaxRedirects,
      );
      if (document.contentType === 'application/pdf') {
        const parsed = await parseDanfePdf(document.bytes);
        if (parsed.status === 'PARSED') results.danfe.push(parsed.danfe);
      } else {
        results.nfe.push(parseNFeXml(document.bytes));
      }
    } catch (error) {
      // URL bloqueada ou documento fiscal invalido nao deve apagar evidencias
      // do email/anexo. Erros que nao pertencem ao dominio continuam subindo.
      if (isExpectedFiscalLinkError(error) || error instanceof NFeXmlParseError || error instanceof DanfePdfParseError) {
        continue;
      }
      throw error;
    }
  }

  return results;
}
