FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/event-bus/package.json /app/packages/event-bus/package.json
COPY packages/models/package.json /app/packages/models/package.json
COPY services/pricing-service/package.json /app/services/pricing-service/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/event-bus /app/packages/event-bus
COPY packages/models /app/packages/models
COPY services/pricing-service /app/services/pricing-service

RUN npm run build -w @blindscloud/models && npm run build -w @blindscloud/event-bus && npm run build -w @blindscloud/pricing-service

WORKDIR /app/services/pricing-service
EXPOSE 4007
CMD ["npm", "run", "start"]
