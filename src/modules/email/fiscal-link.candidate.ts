import type { EmailLink } from './email-contracts.js';

const ANCHOR_SIGNALS = [
  /baixar\s+(?:a\s+)?nota(?:\s+fiscal)?/,
  /(?:nota\s+fiscal|documento\s+fiscal|danfe|nf\s*-?\s*e|nfe)/,
  /xml\s+da\s+nota/,
  /visualizar\s+(?:a\s+)?nota/,
];

const URL_SIGNALS = /(?:nfe|nf-e|danfe|nota-fiscal|invoice|fiscal|xml)/;

function normalize(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Identifica candidatos somente com dados locais do email.
 * Um PDF/XML isolado nao basta: o objetivo e reduzir falsos positivos antes
 * de qualquer operacao de rede, sem transformar o detector em navegador.
 */
export function isFiscalLinkCandidate(link: EmailLink) {
  const anchor = normalize(link.text);
  const href = normalize(link.href);
  const hasStrongAnchor = ANCHOR_SIGNALS.some((signal) => signal.test(anchor));
  const hasFiscalPath = URL_SIGNALS.test(href);

  return hasStrongAnchor || (hasFiscalPath && Boolean(anchor));
}

/** Deduplica por URL normalizada sem alterar a URL que sera requisitada. */
export function getFiscalLinkCandidates(links: EmailLink[], maxPerEmail: number) {
  const seen = new Set<string>();
  const candidates: EmailLink[] = [];

  for (const link of links) {
    if (!isFiscalLinkCandidate(link)) continue;
    const key = link.href.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text: link.text, href: key });
    if (candidates.length >= maxPerEmail) break;
  }

  return candidates;
}
