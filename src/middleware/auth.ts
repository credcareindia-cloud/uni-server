import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    organizationId?: string;
  };
}

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Middleware to authenticate JWT tokens
 */
export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      res.status(500).json({ error: 'Server configuration error' });
      return;
    }

    // Verify JWT token
    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;
    
    // Check if user still exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, organizationId: true }
    });

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }

    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Middleware to check if user has required role
 */
export function requireRole(roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ 
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to check if user is admin
 */
export const requireAdmin = requireRole(['ADMIN']);

/**
 * Middleware to check if user is admin or manager
 */
export const requireManager = requireRole(['ADMIN', 'MANAGER']);

/**
 * Optional authentication - doesn't fail if no token provided
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      next();
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      next();
      return;
    }

    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, organizationId: true }
    });

    if (user) {
      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId
      };
    }

    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
}

// Project-scoped RBAC helpers
export const ProjectRoleOrder = {
  VIEWER: 1,
  MANAGER: 2,
  OWNER: 3,
} as const;

export type ProjectRoleKey = keyof typeof ProjectRoleOrder;

/**
 * Resolve projectId from common locations on the request
 */
export function resolveProjectId(req: Request): number | null {
  const candidates: unknown[] = [
    // Typical REST patterns
    (req.params as any)?.id,
    (req.params as any)?.projectId,
    // Query/body fallbacks
    (req.query as any)?.projectId,
    (req.body as any)?.projectId,
  ];

  for (const val of candidates) {
    if (val === undefined || val === null) continue;
    const n = typeof val === 'string' ? parseInt(val, 10) : Number(val);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Get the user's role within a project (OWNER/MANAGER/VIEWER) or null if not a member
 */
export async function getUserProjectRole(userId: string, projectId: number): Promise<ProjectRoleKey | null> {
  const membership = await prisma.projectMember.findFirst({
    where: { userId, projectId },
    select: { role: true },
  });

  if (!membership) return null;
  // Prisma enum comes back as uppercase string matching our keys
  const role = membership.role as ProjectRoleKey;
  return role;
}

/**
 * Middleware: require at least the given project role for the target project
 * Admins automatically have access to all projects in their organization
 */
export function requireProjectRole(minRole: ProjectRoleKey) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const projectId = resolveProjectId(req);
      if (projectId === null) {
        res.status(400).json({ error: 'Project ID missing' });
        return;
      }

      if (req.user.role === 'ADMIN' && req.user.organizationId) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { organizationId: true }
        });

        if (!project) {
          res.status(404).json({ error: 'Project not found' });
          return;
        }

        if (project.organizationId === req.user.organizationId) {
          next();
          return;
        }

        res.status(403).json({ error: 'Cannot access projects from other organizations' });
        return;
      }

      const userRole = await getUserProjectRole(req.user.id, projectId);
      if (!userRole) {
        res.status(403).json({ error: 'Not a member of this project' });
        return;
      }

      if (ProjectRoleOrder[userRole] < ProjectRoleOrder[minRole]) {
        res.status(403).json({
          error: 'Insufficient project permissions',
          required: minRole,
          current: userRole,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Authorization error in requireProjectRole:', error);
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/**
 * Utility helper to compare two project roles
 */
export function isAtLeastRole(role: ProjectRoleKey, minRole: ProjectRoleKey): boolean {
  return ProjectRoleOrder[role] >= ProjectRoleOrder[minRole];
}
