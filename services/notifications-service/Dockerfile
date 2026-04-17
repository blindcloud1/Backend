FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY packages/models/package.json /app/packages/models/package.json
COPY services/notifications-service/package.json /app/services/notifications-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY packages/models /app/packages/models
COPY services/notifications-service /app/services/notifications-service

RUN npm run build -w @blindscloud/models && npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/notifications-service

WORKDIR /app/services/notifications-service
EXPOSE 4009
CMD ["npm", "run", "start"]
