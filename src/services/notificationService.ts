import { prisma } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { emitNotificationToUser } from './websocket.js';

export type NotificationType = 'SYSTEM' | 'PROJECT_UPDATE' | 'MODEL_PROCESSED' | 'GROUP_STATUS_CHANGE' | 'USER_MENTION';
export type NotificationRole = 'ADMIN' | 'MANAGER' | 'VIEWER' | 'BOTH' | 'ALL';

interface NotificationParams {
  organizationId: string;
  type: NotificationType;
  title: string;
  message: string;
  recipientRole: NotificationRole;
  metadata?: Record<string, any>;
  excludeUserId?: string;
}

async function createNotificationsForRole(params: NotificationParams): Promise<string[]> {
  const { organizationId, type, title, message, recipientRole, metadata, excludeUserId } = params;

  let roleFilter: ('ADMIN' | 'MANAGER' | 'VIEWER')[] = [];

  if (recipientRole === 'ADMIN') {
    roleFilter = ['ADMIN'];
  } else if (recipientRole === 'MANAGER') {
    roleFilter = ['MANAGER'];
  } else if (recipientRole === 'VIEWER') {
    roleFilter = ['VIEWER'];
  } else if (recipientRole === 'BOTH') {
    roleFilter = ['ADMIN', 'MANAGER'];
  } else if (recipientRole === 'ALL') {
    roleFilter = ['ADMIN', 'MANAGER', 'VIEWER'];
  }

  const users = await prisma.user.findMany({
    where: {
      organizationId,
      role: { in: roleFilter as any },
      NOT: excludeUserId ? { id: excludeUserId } : undefined,
    },
    select: { id: true },
  });

  const notifications = await Promise.all(
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
          metadata,
        },
      })
    )
  );

  // Emit WebSocket notifications to each user
  notifications.forEach(notification => {
    try {
      emitNotificationToUser(notification.userId, {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        read: notification.read,
        createdAt: notification.createdAt.toISOString(),
        metadata: notification.metadata as any,
      });
    } catch (error) {
      logger.warn(`Failed to emit WebSocket notification to user ${notification.userId}:`, error);
    }
  });

  logger.info(`Created ${notifications.length} notifications for role ${recipientRole} in organization ${organizationId}`);

  return notifications.map(n => n.id);
}

export const projectNotifications = {
  async createdSuccess(organizationId: string, projectName: string, projectId: number, modelCount: number) {
    return createNotificationsForRole({
      organizationId,
      type: 'PROJECT_UPDATE',
      title: 'Project Created Successfully',
      message: `Project "${projectName}" has been created successfully with ${modelCount} model(s) and is ready to explore.`,
      recipientRole: 'ADMIN',
      metadata: {
        projectId,
        projectName,
        modelCount,
      },
    });
  },

  async createdFailed(organizationId: string, projectName: string, error: string) {
    return createNotificationsForRole({
      organizationId,
      type: 'PROJECT_UPDATE',
      title: 'Project Creation Failed',
      message: `Failed to create project "${projectName}". ${error || 'An unexpected error occurred. Please try again or contact support if the issue persists.'}`,
      recipientRole: 'ADMIN',
      metadata: {
        projectName,
        error,
      },
    });
  },

  async processingStarted(organizationId: string, projectName: string, projectId: number) {
    return createNotificationsForRole({
      organizationId,
      type: 'PROJECT_UPDATE',
      title: 'Project Processing Started',
      message: `Project "${projectName}" is being processed. You'll be notified when it's ready.`,
      recipientRole: 'ADMIN',
      metadata: {
        projectName,
      },
    });
  },
};

export const modelNotifications = {
  async processingCompleted(organizationId: string, modelName: string, projectId: number, projectName: string) {
    return createNotificationsForRole({
      organizationId,
      type: 'MODEL_PROCESSED',
      title: 'Model Processed Successfully',
      message: `Model "${modelName}" from project "${projectName}" has been processed successfully and is ready for viewing.`,
      recipientRole: 'BOTH',
      metadata: {
        projectId,
        projectName,
        modelName,
      },
    });
  },

  async processingFailed(organizationId: string, modelName: string, projectId: number, projectName: string, error: string) {
    return createNotificationsForRole({
      organizationId,
      type: 'MODEL_PROCESSED',
      title: 'Model Processing Failed',
      message: `Model "${modelName}" from project "${projectName}" failed to process. ${error || 'Please try again or contact support.'}`,
      recipientRole: 'ADMIN',
      metadata: {
        projectId,
        projectName,
        modelName,
        error,
      },
    });
  },
};

export const groupNotifications = {
  async statusChanged(organizationId: string, groupName: string, status: string, projectName: string, projectId: number) {
    return createNotificationsForRole({
      organizationId,
      type: 'GROUP_STATUS_CHANGE',
      title: 'Group Status Changed',
      message: `Group "${groupName}" in project "${projectName}" status changed to "${status}".`,
      recipientRole: 'BOTH',
      metadata: {
        projectId,
        projectName,
        groupName,
        status,
      },
    });
  },
};

export const notificationService = {
  createNotificationsForRole,
  projectNotifications,
  modelNotifications,
  groupNotifications,
};
