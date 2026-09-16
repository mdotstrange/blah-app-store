FROM node:24-alpine

# server.js only uses Node's standard library, so there is nothing to install.
WORKDIR /app
COPY server.js .
COPY icon.svg .
COPY public ./public

EXPOSE 3000

# Runs as root (same as docker-compose.yml) so the bind-mounted data dir is
# always writable, even when Docker creates it for us.
CMD ["node", "server.js"]
