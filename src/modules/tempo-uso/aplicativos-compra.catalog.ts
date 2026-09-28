export type AplicativoCompra = Readonly<{
  packageId: string;
  nomeApp: string;
}>;

// Fonte canônica da API.
// Package IDs incluídos somente após validação em dispositivo Android real.
export const APLICATIVOS_COMPRA: readonly AplicativoCompra[] = Object.freeze([
  {
    packageId: 'com.shopee.br',
    nomeApp: 'Shopee',
  },
  {
    packageId: 'com.mercadolibre',
    nomeApp: 'Mercado Livre',
  },
  {
    packageId: 'com.zzkko',
    nomeApp: 'SHEIN',
  },
]);

const aplicativosPorPackageId = new Map(
  APLICATIVOS_COMPRA.map((aplicativo) => [
    aplicativo.packageId,
    aplicativo,
  ]),
);

export function encontrarAplicativoCompra(packageId: string) {
  return aplicativosPorPackageId.get(packageId);
}
