FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
# Migrations first, then the server. The deploy script also runs db:migrate:prod, but only after the
# new container is already up - so new code was serving against the old schema until it got there.
# Running them here closes that window (and makes the script's own run a no-op). A migration that
# fails stops the container from starting, the health check fails, and the deploy rolls back.
CMD ["sh", "-c", "node dist/commands/migrate.js && exec node dist/server.js"]
