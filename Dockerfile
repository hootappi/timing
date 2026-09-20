# syntax=docker/dockerfile:1

# Build stage: install production dependencies (none today) and assemble the app.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public

# Runtime stage: app is root-owned and read-only to the app user; only /app/data is writable.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
