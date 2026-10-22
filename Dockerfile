# intra-skills registry: server + web console + the single-file CLI it hands out, in one image.
# Build:  docker build -t intra-skills .
# Run:    docker run -d -p 7710:7710 -v intra-skills-data:/data \
#           -e INTRA_SKILLS_PUBLIC_URL=https://skills.example.com intra-skills
# On first start with an empty /data, the log prints a one-time setup link for the first admin.

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm build \
 && test -f packages/web/dist/index.html \
 && test -f packages/cli/dist-bundle/intra.mjs
# Keep only what the server needs at run time.
RUN pnpm --filter @intra-skills/server deploy --prod --legacy /out/server \
 && mkdir -p /out/web /out/cli \
 && cp -r packages/web/dist/. /out/web/ \
 && cp packages/cli/dist-bundle/intra.mjs /out/cli/intra.mjs

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    INTRA_SKILLS_DATA=/data \
    INTRA_SKILLS_WEB_DIR=/app/web \
    INTRA_SKILLS_CLI_BUNDLE=/app/cli/intra.mjs \
    HOST=0.0.0.0 \
    PORT=7710
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/web /app/web
COPY --from=build /out/cli /app/cli
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7710
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/server/dist/bin.js", "serve"]
