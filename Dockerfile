# Backend Dockerfile for Uniqube 3D
# Image size can be optimized later with multi-stage + prune once infrastructure is stable

FROM node:20-slim

# Install required system dependencies for Prisma and other native modules
# openssl and ca-certificates are required for Prisma
# procps provides 'ps' command which might be needed
RUN apt-get update -y && apt-get install -y \
    openssl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and Prisma schema first (better caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# CRITICAL FIX: Generate Prisma Client for Debian (prevents segmentation faults)
# This ensures the correct binary is used in AWS Fargate (Debian-based)
ENV PRISMA_CLI_BINARY_TARGETS="debian-openssl-3.0.x"
RUN npx prisma generate --generator client

# Copy tsconfig and source
COPY tsconfig*.json ./
COPY src ./src

# Build TypeScript (quiet, still emits even if TS errors)
RUN npm run build:quiet

# Expose API port
EXPOSE 4000

# Create startup script to clean up failed migrations, then run migrations and start server
RUN printf '#!/bin/sh\necho "Running database migrations..."\necho "Resolving any failed migrations..."\nnpx prisma migrate resolve --rolled-back 20260223000000_fix_panel_fk_on_delete_set_null 2>/dev/null || true\necho "Deploying migrations..."\nnpx prisma migrate deploy\necho "Starting server..."\nnpm start\n' > /app/start.sh && chmod +x /app/start.sh

# Default command
CMD ["/app/start.sh"]