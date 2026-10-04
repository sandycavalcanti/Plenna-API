import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { DeviceController } from './device.controller.js';
import { NotificationController } from './notification.controller.js';

export const notificationRouter = Router();
export const deviceRouter = Router();

notificationRouter.get('/', authMiddleware, NotificationController.list);
notificationRouter.get('/unread-count', authMiddleware, NotificationController.unreadCount);
notificationRouter.patch('/:notificationId/read', authMiddleware, NotificationController.markAsRead);

deviceRouter.post('/push', authMiddleware, DeviceController.registerPush);
deviceRouter.delete('/push/current', authMiddleware, DeviceController.disableCurrent);
