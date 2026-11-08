import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { DeviceService } from './device.service.js';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_EXPO_BATCH_SIZE = 100;
const MAX_PUSH_RETRIES = 5;
const DEFAULT_PUSH_BODY = 'Você tem uma nova atualização no seu planejamento.';
function defaultSettings() {
    return {
        enabled: env.expoPushEnabled,
        accessToken: env.expoPushAccessToken,
        timeoutMs: env.expoPushTimeoutMs,
        batchSize: Math.min(Math.max(1, env.expoPushBatchSize), MAX_EXPO_BATCH_SIZE),
        maxRetries: Math.min(env.expoPushMaxRetries, MAX_PUSH_RETRIES),
        retryBaseDelayMs: env.expoPushRetryBaseDelayMs,
    };
}
function sanitizeError(error) {
    return error.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255) || 'Falha na entrega push';
}
function errorCode(item) {
    // Do not persist provider messages: only the bounded error code is useful
    // operationally and it cannot echo a token or financial payload.
    return item?.details?.error ?? 'ExpoDeliveryError';
}
function isDeviceNotRegistered(code) {
    return code.toLowerCase() === 'devicenotregistered';
}
function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
function errorForTransport(status, error) {
    if (status !== null)
        return sanitizeError(`Expo HTTP ${status}`);
    if (isAbortError(error))
        return 'Expo timeout';
    return 'Falha de comunicação com o Expo Push Service';
}
function outcomesFromExpoPayload(payload, expectedLength) {
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== expectedLength)
        return null;
    return data.map((item) => {
        if (item?.status === 'ok')
            return { kind: 'succeeded', error: null };
        const code = errorCode(item);
        return {
            kind: isDeviceNotRegistered(code) ? 'deactivated' : 'failed',
            error: sanitizeError(code),
        };
    });
}
function chunk(values, size) {
    const result = [];
    for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
    }
    return result;
}
function emptyResult() {
    return { attempted: 0, succeeded: 0, failed: 0, deactivated: 0, skipped: 0 };
}
async function defaultSleep(milliseconds) {
    if (milliseconds <= 0)
        return;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
export class PushService {
    constructor(dependencies = {}) {
        this.db = dependencies.db ?? prisma;
        this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
        this.settings = { ...defaultSettings(), ...dependencies.settings };
        this.settings.batchSize = Math.min(Math.max(1, this.settings.batchSize), MAX_EXPO_BATCH_SIZE);
        this.settings.maxRetries = Math.min(Math.max(0, this.settings.maxRetries), MAX_PUSH_RETRIES);
        this.settings.retryBaseDelayMs = Math.max(0, this.settings.retryBaseDelayMs);
        this.sleep = dependencies.sleep ?? defaultSleep;
    }
    async dispatchForUser(userId, notifications) {
        if (notifications.length === 0)
            return emptyResult();
        if (!this.settings.enabled)
            return { ...emptyResult(), skipped: notifications.length };
        const devices = await DeviceService.listActiveByUserId(userId, this.db);
        if (devices.length === 0)
            return { ...emptyResult(), skipped: notifications.length };
        const entries = devices.flatMap((device) => notifications.map((notification) => ({ device, notification })));
        const result = { ...emptyResult(), attempted: entries.length };
        for (const batch of chunk(entries, this.settings.batchSize)) {
            const outcomes = await this.sendBatch(batch);
            for (const [index, outcome] of outcomes.entries()) {
                const entry = batch[index];
                if (!entry)
                    continue;
                await this.recordOutcome(entry.device.dispositivo_id, outcome);
                if (outcome.kind === 'succeeded')
                    result.succeeded += 1;
                if (outcome.kind === 'failed')
                    result.failed += 1;
                if (outcome.kind === 'deactivated') {
                    result.failed += 1;
                    result.deactivated += 1;
                }
            }
        }
        return result;
    }
    async recordOutcome(deviceId, outcome) {
        try {
            await DeviceService.recordPushAttempt(deviceId, {
                error: outcome.error,
                deactivate: outcome.kind === 'deactivated',
            }, this.db);
        }
        catch {
            // A delivery result must not be turned into a financial-domain failure
            // because an operational device update could not be recorded.
        }
    }
    async sendBatch(batch) {
        const messages = batch.map(({ device, notification }) => ({
            to: device.dispositivo_push_token,
            title: 'Plenna',
            body: notification.body ?? DEFAULT_PUSH_BODY,
            data: {
                notificationId: notification.notificationId,
                type: notification.type,
            },
        }));
        let retry = 0;
        while (true) {
            let response;
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
                try {
                    response = await this.fetchImplementation(EXPO_PUSH_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(this.settings.accessToken
                                ? { Authorization: `Bearer ${this.settings.accessToken}` }
                                : {}),
                        },
                        body: JSON.stringify(messages),
                        signal: controller.signal,
                    });
                }
                finally {
                    clearTimeout(timeout);
                }
            }
            catch (error) {
                if (retry < this.settings.maxRetries) {
                    await this.sleep(this.settings.retryBaseDelayMs * 2 ** retry);
                    retry += 1;
                    continue;
                }
                const message = errorForTransport(null, error);
                return batch.map(() => ({ kind: 'failed', error: message }));
            }
            if (!response.ok) {
                if (isTransientStatus(response.status) && retry < this.settings.maxRetries) {
                    await this.sleep(this.settings.retryBaseDelayMs * 2 ** retry);
                    retry += 1;
                    continue;
                }
                try {
                    const outcomes = outcomesFromExpoPayload(await response.json(), batch.length);
                    if (outcomes)
                        return outcomes;
                }
                catch {
                    // The bounded status error below is sufficient when the provider
                    // does not return a structured response.
                }
                const message = errorForTransport(response.status, null);
                return batch.map(() => ({ kind: 'failed', error: message }));
            }
            let payload;
            try {
                payload = await response.json();
            }
            catch {
                return batch.map(() => ({ kind: 'failed', error: 'Resposta inválida do Expo Push Service' }));
            }
            const outcomes = outcomesFromExpoPayload(payload, batch.length);
            if (!outcomes) {
                return batch.map(() => ({ kind: 'failed', error: 'Resposta incompleta do Expo Push Service' }));
            }
            return outcomes;
        }
    }
}
export const pushService = new PushService();
export async function dispatchPushAfterCommit(userId, notifications) {
    if (notifications.length === 0)
        return emptyResult();
    try {
        return await pushService.dispatchForUser(userId, notifications);
    }
    catch {
        // Push is deliberately best effort after commit. The persisted Central
        // notification remains the source of truth if delivery is unavailable.
        return {
            ...emptyResult(),
            failed: notifications.length,
        };
    }
}
