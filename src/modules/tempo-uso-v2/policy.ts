// Somente a nova flag explícita habilita o protocolo; a variável anterior não
// substitui esta configuração nem autoriza escritas por conta própria.
export const isUsageMonitoringEnabled = () => process.env.USAGE_MONITORING_ENABLED === 'true';
export const RECOVERY_DAYS = 2;
export const ASSOCIATION_LIFETIME_MS = 30 * 86400000;
export class UsageMonitoringError extends Error {
  constructor(public code: string, public status = 409) {
    super(code);
  }
}
