import { z } from 'zod';

const expoPushTokenSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value),
    'pushToken deve ser um Expo Push Token válido',
  );

export const notificationIdSchema = z.coerce.number().int().positive();

export const registerPushDeviceSchema = z.object({
  pushToken: expoPushTokenSchema,
  platform: z.enum(['android', 'ios']),
}).strict();

export const disablePushDeviceSchema = z.object({
  pushToken: expoPushTokenSchema,
}).strict();

export type RegisterPushDeviceDTO = z.infer<typeof registerPushDeviceSchema>;
export type DisablePushDeviceDTO = z.infer<typeof disablePushDeviceSchema>;
