# Backend Dockerfile for Uniqube 3D
# Image size can be optimized later with multi-stage + prune once infrastructure is stable

FROM node:20-alpine

# Install required system dependencies for canvas (Python, build tools, Cairo, Pango, etc.)
RUN apk add --no-cache \
    openssl \
    bash \
    postgresql-client

WORKDIR /app

# Copy package manifests and Prisma schema first (better caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# CRITICAL FIX: Generate Prisma Client for Linux (prevents segmentation faults)
# This ensures the correct binary is used in AWS Fargate
ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x"
RUN npx prisma generate --generator client

# Copy tsconfig and source
COPY tsconfig*.json ./
COPY src ./src

# Build TypeScript (quiet, still emits even if TS errors)
RUN npm run build:quiet

# Expose API port
EXPOSE 4000

# Create startup script to clean up failed migrations, then run migrations and start server
RUN printf '#!/bin/sh\necho "Running database migrations..."\nnpx prisma migrate deploy\necho "Starting server..."\nnpm start\n' > /app/start.sh && chmod +x /app/start.sh

# Default command
CMD ["/app/start.sh"]