FROM node:24.12-alpine

# server.js only uses Node's standard library, so there is nothing to install.
WORKDIR /app
COPY server.js .
COPY icon.svg .
COPY public ./public

# Runs as the unprivileged node user (uid 1000, matching docker-compose.yml).
# /data is created here so a plain `docker run` with a named volume gets a
# mount point the node user can write to.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000

CMD ["node", "server.js"]
