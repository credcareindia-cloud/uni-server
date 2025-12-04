import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

interface AuthenticatedSocket extends Socket {
    userId?: string;
}

let io: SocketIOServer | null = null;

export function initializeWebSocket(httpServer: HttpServer): SocketIOServer {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:3000',
            credentials: true,
        },
        transports: ['websocket', 'polling'], // Support both for compatibility
    });

    // Authentication middleware
    io.use((socket: AuthenticatedSocket, next) => {
        try {
            const token = socket.handshake.auth.token;

            if (!token) {
                logger.warn('WebSocket connection attempt without token');
                return next(new Error('Authentication error: No token provided'));
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as { userId: string };
            socket.userId = decoded.userId;
            next();
        } catch (error) {
            logger.error('WebSocket authentication error:', error);
            next(new Error('Authentication error: Invalid token'));
        }
    });

    io.on('connection', (socket: AuthenticatedSocket) => {
        logger.info(`WebSocket client connected: ${socket.id} (User: ${socket.userId})`);

        // Join user-specific room for targeted notifications
        if (socket.userId) {
            socket.join(`user:${socket.userId}`);
        }

        socket.on('disconnect', () => {
            logger.info(`WebSocket client disconnected: ${socket.id}`);
        });
    });

    logger.info('WebSocket server initialized');
    return io;
}

export function getIO(): SocketIOServer {
    if (!io) {
        throw new Error('Socket.io not initialized. Call initializeWebSocket first.');
    }
    return io;
}

// Helper function to emit notification to a specific user
export function emitNotificationToUser(userId: string, notification: any) {
    if (!io) {
        logger.warn('Socket.io not initialized, cannot emit notification');
        return;
    }

    io.to(`user:${userId}`).emit('notification', notification);
    logger.info(`Notification emitted to user ${userId}`);
}

// Helper function to emit notification to all connected clients
export function emitNotificationToAll(notification: any) {
    if (!io) {
        logger.warn('Socket.io not initialized, cannot emit notification');
        return;
    }

    io.emit('notification', notification);
    logger.info('Notification emitted to all users');
}
