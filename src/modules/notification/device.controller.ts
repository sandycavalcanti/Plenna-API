import { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { disablePushDeviceSchema, registerPushDeviceSchema } from './notification.schemas.js';
import { DeviceService } from './device.service.js';

export class DeviceController {
  static async registerPush(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const data = registerPushDeviceSchema.parse(req.body);
      const device = await DeviceService.registerPushToken(req.userId, data.pushToken, data.platform);
      return res.status(200).json(device);
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async disableCurrent(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const data = disablePushDeviceSchema.parse(req.body);
      await DeviceService.disablePushToken(req.userId, data.pushToken);
      return res.status(204).send();
    } catch (error: unknown) {
      return handleError(res, 404, error);
    }
  }
}
