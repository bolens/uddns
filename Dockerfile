FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS dependencies

RUN npm install --global pnpm@11.24.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN VP_GIT_HOOKS=0 pnpm install --frozen-lockfile

FROM dependencies AS build
COPY app.ts mcp.ts cli.ts package.json tsconfig.json tsconfig.build.json ./
COPY lib ./lib
RUN pnpm run build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod --ignore-scripts

FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

WORKDIR /app
COPY package.json LICENSE THIRD_PARTY_LICENSES.txt THIRD_PARTY_NOTICES.md ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data

USER node
ENV UDDNS_DATA_DIR=/data
ENV UDDNS_STATE_FILE=/data/state.json
ENV UDDNS_HISTORY_FILE=/data/history.json
ENV UDDNS_HEALTH=1
ENV UDDNS_HEALTH_HOST=127.0.0.1
ENV UDDNS_HEALTH_PORT=3924
VOLUME ["/data"]
EXPOSE 3924
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3924/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["dist/app.js"]
