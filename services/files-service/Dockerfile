FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY packages/models/package.json /app/packages/models/package.json
COPY services/files-service/package.json /app/services/files-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY packages/models /app/packages/models
COPY services/files-service /app/services/files-service

RUN npm run build -w @blindscloud/models && npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/files-service

WORKDIR /app/services/files-service
VOLUME ["/data/uploads"]
EXPOSE 4010
CMD ["npm", "run", "start"]
