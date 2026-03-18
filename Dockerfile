FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY packages/config/package.json packages/config/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/

RUN npm install --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/ packages/

RUN npm run build

EXPOSE 8080

CMD ["node", "packages/server/dist/index.js"]
