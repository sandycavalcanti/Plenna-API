import { usageStorageKind } from './storage.js';
/** Reutiliza o lock FOR UPDATE de tb_usuario, sem rede ou transação aninhada. */
export async function revokeUsageAssociations(tx, account) {
    const kind = await usageStorageKind(tx);
    if (!kind)
        return;
    if (kind === 'current') {
        await tx.$executeRaw `UPDATE public.tb_monitoramento_instalacao SET usuario_ativo_id=NULL,sessao_cliente=NULL,inicio_contexto=NULL,fuso_contexto=NULL,coleta_id=NULL,coleta_ate=NULL,contexto_id=gen_random_uuid() WHERE usuario_ativo_id=${account}`;
        return;
    }
    const now = new Date().toISOString();
    await tx.$executeRaw `UPDATE public.rf017_authorization SET document=jsonb_set(document,'{revokedAt}',to_jsonb(${now}::text)) WHERE "accountId"=${account} AND document->>'revokedAt' IS NULL`;
    await tx.$executeRaw `UPDATE public.rf017_association SET state='CLOSED',document=document || jsonb_build_object('state','CLOSED','endedAt',${now}::text,'closeReason','CONSENT_REVOKED') WHERE "accountId"=${account} AND state='ACTIVE'`;
}
