FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY packages/models/package.json /app/packages/models/package.json
COPY services/demo-requests-service/package.json /app/services/demo-requests-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY packages/models /app/packages/models
COPY services/demo-requests-service /app/services/demo-requests-service

RUN npm run build -w @blindscloud/models && npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/demo-requests-service

WORKDIR /app/services/demo-requests-service
EXPOSE 4012
CMD ["npm", "run", "start"]
