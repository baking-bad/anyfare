# syntax=docker/dockerfile:1
# One image for every app. Each stack service sets its own command: node packages/<app>/dist/main.js.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npx tsc -b
RUN rm -rf packages/*/src packages/*/tests packages/*/tsconfig*.json packages/*/drizzle.config.ts packages/*/dist/.tsbuildinfo

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Migrations run as a one-off command from this image before the apps roll: node packages/db/dist/migrate.js,
# which applies packages/db/migrations/ to DATABASE_URL.
# The platform configs ship in the image, one per deployment. The stack picks one with CONFIG_PATH.
COPY config ./config
# The commit the image is built from: every app's startup line names it. CI passes it.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
USER node
CMD ["node", "packages/api/dist/main.js"]
