FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY services/auth-service/package.json /app/services/auth-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY services/auth-service /app/services/auth-service

RUN npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/auth-service

WORKDIR /app/services/auth-service
EXPOSE 4001
CMD ["npm", "run", "start"]
