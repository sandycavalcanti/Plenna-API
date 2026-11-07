import type { Tombstone } from './contracts.js';
import { localDayInterval, overlaps } from './time.js';
import { APLICATIVOS_COMPRA } from '../tempo-uso/aplicativos-compra.catalog.js';
type Row = {
  tempo_uso_nome: string;
  tempo_uso_package_id: string | null;
  tempo_uso_inicio: Date | null;
  tempo_uso_fim: Date | null;
  tempo_uso_data_local: Date | null;
  tempo_uso_data: Date | null;
  tempo_uso_duracao_segundos: number | null;
  tempo_uso_minutos: unknown;
};
/** Filtra a leitura sem alterar a tabela legada nem inventar a origem dos dados. */
export function redactLegacy<T extends Row>(rows: T[], tombstones: Tombstone[]): T[] {
  return rows.map(row => {
    const packageId = row.tempo_uso_package_id ?? APLICATIVOS_COMPRA.find(a => a.nomeApp === row.tempo_uso_nome)?.packageId;
    const date = row.tempo_uso_data_local ?? row.tempo_uso_data;
    // Sem intervalo, não é possível descartar sobreposição com uma exclusão.
    // Preserva a identidade do registro e sinaliza a incerteza sem expor o total.
    const interval = row.tempo_uso_inicio && row.tempo_uso_fim ? {
      start: row.tempo_uso_inicio.toISOString(),
      end: row.tempo_uso_fim.toISOString()
    } : null;
    const matching = tombstones.filter(t => {
      // O v1 não identifica a instalação. Somente uma exclusão da conta pode
      // abranger essa fonte sem inventar uma associação de dispositivo.
      if (t.target.kind !== 'ACCOUNT') return false;
      const wanted = t.scope.kind === 'APP_DAY' ? [t.scope.packageId] : t.scope.packageIds;
      if (packageId && wanted && !wanted.includes(packageId)) return false;
      const period = t.effectiveInterval ?? (t.scope.kind === 'APP_DAY' ? localDayInterval(t.scope.localDate, t.scope.timezone) : t.scope.interval);
      if (interval) return overlaps(interval, period);
      if (!date) return true;
      // São limites conservadores, não um intervalo de uso comprovado.
      return overlaps({
        start: new Date(date.getTime() - 26 * 3600000).toISOString(),
        end: new Date(date.getTime() + 50 * 3600000).toISOString()
      }, period);
    });
    return matching.length ? {
      ...row,
      tempo_uso_duracao_segundos: null,
      tempo_uso_minutos: null,
      rf017_suppression: {
        reason: interval && packageId ? 'DELETED_INTERVAL' : 'LEGACY_PROVENANCE_UNCERTAIN',
        tombstoneIds: matching.map(t => t.id)
      }
    } : row;
  });
}
