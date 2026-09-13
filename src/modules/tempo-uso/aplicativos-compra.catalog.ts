export type AplicativoCompra = Readonly<{
  packageId: string;
  nomeApp: string;
}>;

// Fonte canônica da API. Permanece vazia até a aprovação dos package IDs reais.
// Não adicionar nomes ou IDs presumidos neste catálogo.
export const APLICATIVOS_COMPRA: readonly AplicativoCompra[] = Object.freeze([]);

const aplicativosPorPackageId = new Map(
  APLICATIVOS_COMPRA.map((aplicativo) => [aplicativo.packageId, aplicativo]),
);

export function encontrarAplicativoCompra(packageId: string) {
  return aplicativosPorPackageId.get(packageId);
}
