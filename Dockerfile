FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY packages/config/package.json packages/config/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/

RUN npm install --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/ packages/

RUN npm run build

COPY examples/leaderboard/wavelet.config.ts ./

EXPOSE 8080

CMD ["node", "packages/cli/dist/index.js", "dev"]
