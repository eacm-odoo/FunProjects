# The teacher in one container, for Railway, Render, Fly.io or any server with
# Docker (see "Hosting it" in the README). The keys never go into the image:
# set them as the platform's variables.
#
# Node 26: LTS since October 2026 and one of the two lines the tests run on.

# --- Build: the page, with the dev tools (Vite) -----------------------------
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY server ./server
RUN npm run build

# --- Run: the server and the built page, nothing else -----------------------
FROM node:26-slim
# /data: mount a volume there, or shared links and kept answers are lost on
# every deploy. The platform's PORT, when it sets one, wins over 8787.
ENV NODE_ENV=production \
    PORT=8787 \
    SHARES_DIR=/data/shares \
    CACHE_DIR=/data/cache
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8787
# Still root: Railway mounts volumes as root, and the server must write there.
# HOST is fixed here, not in ENV: inside a container the platform's proxy is
# the only way in, and a HOST=127.0.0.1 pasted from .env would shut it out.
# exec: node gets the platform's SIGTERM and closes the connections itself.
CMD ["sh", "-c", "HOST=0.0.0.0 exec node server/src/index.js --prod"]
