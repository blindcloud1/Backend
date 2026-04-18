FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY packages/models/package.json /app/packages/models/package.json
COPY services/orders-service/package.json /app/services/orders-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY packages/models /app/packages/models
COPY services/orders-service /app/services/orders-service

RUN npm run build -w @blindscloud/models && npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/orders-service

WORKDIR /app/services/orders-service
EXPOSE 4011
CMD ["npm", "run", "start"]
