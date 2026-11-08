import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { NotificationService } from './notification.service.js';
import { dispatchPushAfterCommit } from './push.service.js';
import { SEASONAL_EVENTS, SEASONAL_LEAD_DAYS, resolveEligibleSeasonalEvents, } from './seasonal-calendar.js';
const MAX_SEASONAL_USER_BATCH_SIZE = 1000;
function emptyResult(eventsMatched = 0) {
    return {
        eventsMatched,
        usersProcessed: 0,
        notificationsCreated: 0,
        duplicatesSkipped: 0,
        failures: 0,
        pushAttempted: 0,
        pushSucceeded: 0,
        pushFailed: 0,
        pushDeactivated: 0,
        pushSkipped: 0,
    };
}
function normalizeBatchSize(value) {
    return Math.min(Math.max(1, Math.floor(value)), MAX_SEASONAL_USER_BATCH_SIZE);
}
function idempotencyKey(userId, event) {
    return `${userId}:SAZONAL:${event.definition.code}:${event.eventDate.year}:${SEASONAL_LEAD_DAYS}`;
}
function mergePushResult(result, push) {
    result.pushAttempted += push.attempted;
    result.pushSucceeded += push.succeeded;
    result.pushFailed += push.failed;
    result.pushDeactivated += push.deactivated;
    result.pushSkipped += push.skipped;
}
export async function processSeasonalNotifications(referenceDate = new Date(), options = {}) {
    const db = options.db ?? prisma;
    const catalog = options.catalog ?? SEASONAL_EVENTS;
    const dispatch = options.dispatch ?? dispatchPushAfterCommit;
    const eligibleEvents = resolveEligibleSeasonalEvents(referenceDate, catalog);
    const result = emptyResult(eligibleEvents.length);
    if (eligibleEvents.length === 0)
        return result;
    const batchSize = normalizeBatchSize(options.userBatchSize ?? env.seasonalNotificationUserBatchSize);
    let lastUserId = 0;
    while (true) {
        const users = await db.tb_usuario.findMany({
            where: {
                usuario_status: true,
                ...(lastUserId > 0 ? { usuario_id: { gt: lastUserId } } : {}),
            },
            orderBy: { usuario_id: 'asc' },
            take: batchSize,
            select: { usuario_id: true },
        });
        if (users.length === 0)
            break;
        result.usersProcessed += users.length;
        for (const user of users) {
            for (const event of eligibleEvents) {
                try {
                    const created = await NotificationService.createNotification({
                        userId: user.usuario_id,
                        type: 'SAZONAL',
                        title: event.definition.title,
                        message: event.definition.message,
                        idempotencyKey: idempotencyKey(user.usuario_id, event),
                        purchaseId: null,
                        categoryId: null,
                        event: event.definition.code,
                    }, db);
                    if (!created.created) {
                        result.duplicatesSkipped += 1;
                        continue;
                    }
                    result.notificationsCreated += 1;
                    try {
                        const push = await dispatch(user.usuario_id, [{
                                notificationId: created.notification.notificacao_id,
                                type: 'SAZONAL',
                            }]);
                        mergePushResult(result, push);
                    }
                    catch {
                        // Delivery is best-effort. Persistence succeeded and remains the
                        // source of truth even if a dispatcher implementation throws.
                        result.pushFailed += 1;
                    }
                }
                catch {
                    // A single user's event must not prevent the remaining active users
                    // and events from being processed. The nonzero counter makes the
                    // cron response signal that the execution was not fully successful.
                    result.failures += 1;
                }
            }
        }
        lastUserId = users[users.length - 1].usuario_id;
    }
    return result;
}
export class SeasonalNotificationService {
    static async process(referenceDate = new Date(), options = {}) {
        return processSeasonalNotifications(referenceDate, options);
    }
}
