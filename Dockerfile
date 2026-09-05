FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# deps first so a code-only change doesn't re-run npm ci
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# rooms.json is mirrored here; mounted as a volume so an in-progress
# game survives a container recreate
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node

# listen on all interfaces inside the netns so cloudflared can reach us
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
