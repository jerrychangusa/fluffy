FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -m 700 /state && chown node:node /state
COPY --chown=node:node src ./src
COPY --chown=node:node agents ./agents
COPY --chown=node:node assets/intake-form.mjs ./assets/intake-form.mjs
USER node
ENV NODE_ENV=production AGENT_STATE_DIR=/state AGENT_PORT=8000
EXPOSE 8000
STOPSIGNAL SIGTERM
CMD ["node", "agents/support/server.mjs"]
