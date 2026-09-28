import { promises as dns } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { env } from '../../lib/env.js';

export class FiscalUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalUrlPolicyError';
  }
}

export type ValidatedFiscalUrl = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

function normalizedIpHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '');
}

function assertPublicAddress(address: string) {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new FiscalUrlPolicyError('Endereco DNS invalido');
  }

  // O modo allow-public bloqueia tambem ranges reservados que nao aparecem
  // apenas como "private", incluindo loopback, link-local e metadata.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  if (parsed.range() !== 'unicast') {
    throw new FiscalUrlPolicyError('Endereco DNS nao publico');
  }
}

function validateUrlShape(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FiscalUrlPolicyError('URL fiscal invalida');
  }

  if (url.protocol !== 'https:') throw new FiscalUrlPolicyError('Somente HTTPS e permitido');
  if (!url.hostname || url.hostname.endsWith('.')) throw new FiscalUrlPolicyError('Hostname fiscal invalido');
  if (url.username || url.password) throw new FiscalUrlPolicyError('Credenciais na URL nao sao permitidas');
  if (url.port && url.port !== '443') throw new FiscalUrlPolicyError('Somente a porta HTTPS 443 e permitida');

  // Fragmentos sao destinados ao cliente e nao precisam ser enviados ao
  // servidor; query strings permanecem intactas porque podem conter assinatura.
  url.hash = '';
  return url;
}

/**
 * Valida URL e DNS antes da conexao. Todos os enderecos devem ser publicos;
 * aceitar o primeiro IP e ignorar outro resultado permitiria SSRF parcial.
 */
export async function validateFiscalUrl(rawUrl: string, timeoutMs = env.emailFiscalLinkTimeoutMs): Promise<ValidatedFiscalUrl> {
  const url = validateUrlShape(rawUrl);
  const hostname = url.hostname.toLowerCase();
  const ipHost = normalizedIpHost(hostname);
  const addresses = ipaddr.isValid(ipHost)
    ? [{ address: ipHost, family: ipaddr.parse(ipHost).kind() === 'ipv4' ? 4 as const : 6 as const }]
    : await resolveHostname(hostname, timeoutMs);

  for (const result of addresses) assertPublicAddress(result.address);
  const selected = [...addresses].sort((a, b) => a.address.localeCompare(b.address))[0];
  if (!selected) throw new FiscalUrlPolicyError('Hostname sem endereco DNS');

  return { url, hostname, address: selected.address, family: selected.family };
}

async function resolveHostname(hostname: string, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = dns.lookup(hostname, { all: true, verbatim: true });
    // O request HTTP possui timeout proprio, mas a resolucao DNS acontece
    // antes dele; por isso ela tambem precisa de limite e timer limpo.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FiscalUrlPolicyError('Timeout ao resolver hostname fiscal')), timeoutMs);
    });
    const results = await Promise.race([lookup, timeout]);
    if (results.length === 0) throw new FiscalUrlPolicyError('Hostname sem endereco DNS');
    return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
  } catch (error) {
    if (error instanceof FiscalUrlPolicyError) throw error;
    throw new FiscalUrlPolicyError('Falha ao resolver hostname fiscal');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
