FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY services/users-service/package.json /app/services/users-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY services/users-service /app/services/users-service

RUN npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/users-service

WORKDIR /app/services/users-service
EXPOSE 4002
CMD ["npm", "run", "start"]
