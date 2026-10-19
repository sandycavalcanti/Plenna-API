import { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { notificationIdSchema } from './notification.schemas.js';
import { NotificationService } from './notification.service.js';

export class NotificationController {
  static async list(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.status(200).json(await NotificationService.listByUserId(req.userId));
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }

  static async unreadCount(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const count = await NotificationService.countUnread(req.userId);
      return res.status(200).json({ count });
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }

  static async markAsRead(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const notificationId = notificationIdSchema.parse(req.params.notificationId);
      const notification = await NotificationService.markAsRead(req.userId, notificationId);
      return res.status(200).json(notification);
    } catch (error: unknown) {
      return handleError(res, 404, error);
    }
  }
}
