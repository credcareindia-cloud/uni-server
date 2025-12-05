import { Router, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../config/database.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Rate limiting for notification endpoints to prevent rapid polling
const notificationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  message: 'Too many notification requests, please slow down',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all notification routes
router.use(notificationLimiter);

// Validation schemas
const querySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1).optional(),
  limit: z.string().transform(val => Math.min(parseInt(val) || 20, 100)).optional(),
  type: z.enum(['SYSTEM', 'PROJECT_UPDATE', 'MODEL_PROCESSED', 'GROUP_STATUS_CHANGE', 'USER_MENTION']).optional(),
  read: z.string().transform(val => val === 'true' ? true : val === 'false' ? false : undefined).optional(),
});

export const createNotificationSchema = z.object({
  type: z.enum(['SYSTEM', 'PROJECT_UPDATE', 'MODEL_PROCESSED', 'GROUP_STATUS_CHANGE', 'USER_MENTION']),
  title: z.string(),
  message: z.string(),
  recipientRole: z.enum(['ADMIN', 'MANAGER', 'BOTH', 'ALL', 'VIEWER']).optional().default('ADMIN'),
  metadata: z.record(z.any()).optional(),
});

const markReadSchema = z.object({
  notificationIds: z.array(z.string().cuid()).optional(),
  markAll: z.boolean().optional(),
});

/**
 * GET /api/notifications
 * Get notifications for the authenticated user (organization-scoped)
 */
router.get('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  if (!req.user.organizationId) {
    throw createApiError('User organization not found', 400);
  }

  const { page = 1, limit = 20, type, read } = querySchema.parse(req.query);
  const skip = (page - 1) * limit;

  // Build where clause - filter by organization and user
  const where: any = {
    userId: req.user.id,
    organizationId: req.user.organizationId
  };

  if (type) {
    where.type = type;
  }

  if (read !== undefined) {
    where.read = read;
  }

  // Get notifications with pagination
  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        read: true,
        metadata: true,
        createdAt: true
      }
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: {
        userId: req.user.id,
        organizationId: req.user.organizationId,
        read: false
      }
    })
  ]);

  // Transform notifications to match frontend format
  const transformedNotifications = notifications.map(notification => ({
    id: notification.id,
    type: notification.type.toLowerCase().replace('_', '-'),
    title: notification.title,
    message: notification.message,
    read: notification.read,
    metadata: notification.metadata,
    createdAt: notification.createdAt,
    avatar: getNotificationAvatar(notification.type)
  }));

  res.json({
    notifications: transformedNotifications,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    },
    unreadCount
  });
}));

/**
 * PATCH /api/notifications/mark-read
 * Mark notifications as read
 */
router.patch('/mark-read', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { notificationIds, markAll } = markReadSchema.parse(req.body);

  if (!notificationIds && !markAll) {
    throw createApiError('Either notificationIds or markAll must be provided', 400);
  }

  let updateCount = 0;

  if (markAll) {
    // Mark all unread notifications as read
    const result = await prisma.notification.updateMany({
      where: {
        userId: req.user.id,
        read: false
      },
      data: {
        read: true
      }
    });
    updateCount = result.count;
  } else if (notificationIds && notificationIds.length > 0) {
    // Mark specific notifications as read
    const result = await prisma.notification.updateMany({
      where: {
        id: { in: notificationIds },
        userId: req.user.id,
        read: false
      },
      data: {
        read: true
      }
    });
    updateCount = result.count;
  }

  logger.info(`Marked ${updateCount} notifications as read for user ${req.user.email}`);

  res.json({
    message: `Marked ${updateCount} notifications as read`,
    count: updateCount
  });
}));

/**
 * PATCH /api/notifications/mark-unread
 * Mark notifications as unread
 */
router.patch('/mark-unread', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { notificationIds } = markReadSchema.parse(req.body);

  if (!notificationIds || notificationIds.length === 0) {
    throw createApiError('notificationIds must be provided', 400);
  }

  const result = await prisma.notification.updateMany({
    where: {
      id: { in: notificationIds },
      userId: req.user.id
    },
    data: {
      read: false
    }
  });

  logger.info(`Marked ${result.count} notifications as unread for user ${req.user.email}`);

  res.json({
    message: `Marked ${result.count} notifications as unread`,
    count: result.count
  });
}));

/**
 * DELETE /api/notifications/:id
 * Delete a specific notification
 */
router.delete('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  // Verify notification exists and belongs to user
  const notification = await prisma.notification.findFirst({
    where: {
      id,
      userId: req.user.id
    }
  });

  if (!notification) {
    throw createApiError('Notification not found', 404);
  }

  // Delete notification
  await prisma.notification.delete({
    where: { id }
  });

  logger.info(`Notification deleted: ${id} by ${req.user.email}`);

  res.json({
    message: 'Notification deleted successfully'
  });
}));

/**
 * DELETE /api/notifications
 * Delete multiple notifications or all read notifications
 */
router.delete('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const deleteSchema = z.object({
    notificationIds: z.array(z.string().cuid()).optional(),
    deleteAllRead: z.boolean().optional(),
  });

  const { notificationIds, deleteAllRead } = deleteSchema.parse(req.body);

  if (!notificationIds && !deleteAllRead) {
    throw createApiError('Either notificationIds or deleteAllRead must be provided', 400);
  }

  let deleteCount = 0;

  if (deleteAllRead) {
    // Delete all read notifications
    const result = await prisma.notification.deleteMany({
      where: {
        userId: req.user.id,
        read: true
      }
    });
    deleteCount = result.count;
  } else if (notificationIds && notificationIds.length > 0) {
    // Delete specific notifications
    const result = await prisma.notification.deleteMany({
      where: {
        id: { in: notificationIds },
        userId: req.user.id
      }
    });
    deleteCount = result.count;
  }

  logger.info(`Deleted ${deleteCount} notifications for user ${req.user.email}`);

  res.json({
    message: `Deleted ${deleteCount} notifications`,
    count: deleteCount
  });
}));

/**
 * GET /api/notifications/unread-count
 * Get count of unread notifications (organization-scoped)
 */
router.get('/unread-count', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  if (!req.user.organizationId) {
    throw createApiError('User organization not found', 400);
  }

  const unreadCount = await prisma.notification.count({
    where: {
      userId: req.user.id,
      organizationId: req.user.organizationId,
      read: false
    }
  });

  res.json({ unreadCount });
}));

/**
 * POST /api/notifications/test
 * Create a test notification (development only)
 */
router.post('/test', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  if (process.env.NODE_ENV === 'production') {
    throw createApiError('Test notifications not available in production', 403);
  }

  const testSchema = z.object({
    type: z.enum(['SYSTEM', 'PROJECT_UPDATE', 'MODEL_PROCESSED', 'GROUP_STATUS_CHANGE', 'USER_MENTION']).optional().default('SYSTEM'),
    title: z.string().optional().default('Test Notification'),
    message: z.string().optional().default('This is a test notification'),
  });

  const { type, title, message } = testSchema.parse(req.body);

  const notification = await prisma.notification.create({
    data: {
      userId: req.user.id,
      type,
      title,
      message,
      metadata: {
        test: true,
        createdBy: 'test-endpoint'
      }
    }
  });

  res.json({
    message: 'Test notification created',
    notification: {
      id: notification.id,
      type: notification.type.toLowerCase().replace('_', '-'),
      title: notification.title,
      message: notification.message,
      read: notification.read,
      createdAt: notification.createdAt,
      avatar: getNotificationAvatar(notification.type)
    }
  });
}));

/**
 * Helper function to get avatar URL based on notification type
 */
function getNotificationAvatar(type: string): string {
  const avatarMap: Record<string, string> = {
    'SYSTEM': '/avatars/system.png',
    'PROJECT_UPDATE': '/avatars/project.png',
    'MODEL_PROCESSED': '/avatars/model.png',
    'GROUP_STATUS_CHANGE': '/avatars/group.png',
    'USER_MENTION': '/avatars/user.png'
  };

  return avatarMap[type] || '/avatars/default.png';
}

/**
 * Helper function to create notifications for multiple users based on role
 * This is called internally by other services (e.g., project creation)
 */
export async function createNotificationsForRole(params: {
  organizationId: string;
  type: 'SYSTEM' | 'PROJECT_UPDATE' | 'MODEL_PROCESSED' | 'GROUP_STATUS_CHANGE' | 'USER_MENTION';
  title: string;
  message: string;
  recipientRole: 'ADMIN' | 'MANAGER' | 'BOTH' | 'ALL' | 'VIEWER';
  metadata?: Record<string, any>;
  excludeUserId?: string; // Optionally exclude one user (e.g., the one who triggered it)
}): Promise<string[]> {
  const { organizationId, type, title, message, recipientRole, metadata, excludeUserId } = params;

  // Determine which roles should receive the notification
  let roleFilter: ('ADMIN' | 'MANAGER' | 'VIEWER')[] = [];

  if (recipientRole === 'ADMIN') {
    roleFilter = ['ADMIN'];
  } else if (recipientRole === 'MANAGER') {
    roleFilter = ['MANAGER'];
  } else if (recipientRole === 'BOTH') {
    roleFilter = ['ADMIN', 'MANAGER'];
  } else if (recipientRole === 'VIEWER') {
    roleFilter = ['VIEWER'];
  } else if (recipientRole === 'ALL') {
    roleFilter = ['ADMIN', 'MANAGER', 'VIEWER'];
  }

  // Find all users in organization with the specified roles
  const users = await prisma.user.findMany({
    where: {
      organizationId,
      role: { in: roleFilter as any },
      NOT: excludeUserId ? { id: excludeUserId } : undefined
    },
    select: { id: true }
  });

  // Create notifications for each user
  const notificationIds = await Promise.all(
    users.map(user =>
      prisma.notification.create({
        data: {
          userId: user.id,
          organizationId,
          type: type as any,
          title,
          message,
          read: false,
          recipientRole: recipientRole as any,
          metadata
        }
      }).then(n => n.id)
    )
  );

  logger.info(`Created ${notificationIds.length} notifications for role ${recipientRole} in organization ${organizationId}`);

  return notificationIds;
}

export { router as notificationRoutes };
