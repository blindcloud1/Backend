FROM node:20-alpine AS base
WORKDIR /app

COPY package.json /app/package.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY services/api-gateway/package.json /app/services/api-gateway/package.json

RUN npm install --workspaces --include-workspace-root

COPY services/api-gateway /app/services/api-gateway

RUN npm run build -w @blindscloud/api-gateway

WORKDIR /app/services/api-gateway
EXPOSE 3001
CMD ["npm", "run", "start"]
