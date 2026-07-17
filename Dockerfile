FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN VITE_GIT_HOOKS=0 pnpm install --frozen-lockfile
COPY app.ts tsconfig.json tsconfig.build.json ./
COPY lib ./lib
RUN pnpm run build

FROM node:24-alpine

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data

USER node
ENV UDDNS_STATE_FILE=/data/state.json
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/app.js"]
