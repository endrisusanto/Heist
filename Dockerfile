# Stage 1: Build Client & Server
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root manifest and workspaces
COPY package.json package-lock.json* ./
COPY web-hub/client/package.json ./web-hub/client/
COPY web-hub/server/package.json ./web-hub/server/

RUN npm install

# Copy source files
COPY web-hub ./web-hub

# Build client and server
RUN npm run build

# Stage 2: Production Runner
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4020

COPY package.json ./
COPY web-hub/server/package.json ./web-hub/server/
COPY web-hub/client/package.json ./web-hub/client/

RUN npm install --omit=dev --workspace=web-hub/server

COPY --from=builder /app/web-hub/client/dist ./web-hub/client/dist
COPY --from=builder /app/web-hub/server/dist ./web-hub/server/dist

EXPOSE 4020

CMD ["node", "web-hub/server/dist/index.js"]
