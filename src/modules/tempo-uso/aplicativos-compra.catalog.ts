export type AplicativoCompra = Readonly<{
  packageId: string;
  nomeApp: string;
}>;

export const APLICATIVOS_COMPRA: readonly AplicativoCompra[] = Object.freeze([
  { packageId: 'com.shopee.br', nomeApp: 'Shopee' },
  { packageId: 'com.mercadolibre', nomeApp: 'Mercado Livre' },
  { packageId: 'com.zzkko', nomeApp: 'SHEIN' },
]);
