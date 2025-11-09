# Backend Dockerfile for Uniqube 3D
# Image size can be optimized later with multi-stage + prune once infrastructure is stable

FROM node:20-alpine

# Install required system dependencies (optional: openssl, bash handy for debug)
RUN apk add --no-cache openssl bash

WORKDIR /app

# Copy package manifests and Prisma schema first (better caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy tsconfig and source
COPY tsconfig*.json ./
COPY src ./src

# Build TypeScript (quiet, still emits even if TS errors)
RUN npm run build:quiet

# Expose API port
EXPOSE 4000

# Default command
CMD ["npm", "start"]
