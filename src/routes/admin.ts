import express from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Middleware to check if user is admin
const requireAdmin = async (req: any, res: any, next: any) => {
  try {
    // req.user is already populated by authenticateToken middleware
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Apply admin check to all routes
router.use(requireAdmin);

// Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Transform data to match frontend interface
    const transformedUsers = users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.toLowerCase(),
      status: 'active', // You can add a status field to the User model if needed
      projects: user._count.projects,
      createdAt: user.createdAt
    }));

    res.json(transformedUsers);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new user
router.post('/users', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Convert role to uppercase for Prisma enum
    const userRole = role ? role.toUpperCase() : 'USER';

    // Create user
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword,
        role: userRole as 'USER' | 'MANAGER' | 'ADMIN'
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    res.status(201).json({
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role.toLowerCase(),
      status: 'active',
      projects: 0,
      createdAt: newUser.createdAt
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Delete user
router.delete('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Prevent deleting yourself
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete user (this will cascade delete related data based on your schema)
    await prisma.user.delete({
      where: { id: userId }
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Update user (name, email, role)
router.patch('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, role } = req.body;

    // Prevent changing your own role
    if (userId === req.user.id && role) {
      const currentUser = await prisma.user.findUnique({ where: { id: userId } });
      if (currentUser && currentUser.role !== role.toUpperCase()) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }
    }

    // Check if email is already taken by another user
    if (email) {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser && existingUser.id !== userId) {
        return res.status(400).json({ error: 'Email is already taken' });
      }
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (role) updateData.role = role.toUpperCase() as 'USER' | 'MANAGER' | 'ADMIN';

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            projects: true
          }
        }
      }
    });

    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role.toLowerCase(),
      status: 'active',
      projects: updatedUser._count.projects,
      createdAt: updatedUser.createdAt
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Update user role only (legacy endpoint)
router.patch('/users/:userId/role', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    // Prevent changing your own role
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const userRole = role.toUpperCase();

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role: userRole as 'USER' | 'MANAGER' | 'ADMIN' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role.toLowerCase(),
      status: 'active',
      createdAt: updatedUser.createdAt
    });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

export default router;
