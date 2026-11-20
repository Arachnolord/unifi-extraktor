FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html anmeldung.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY sicherheit.inc /etc/nginx/conf.d/sicherheit.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# Die Anmeldeseite braucht kein Backend - sie zeigt, dass nginx selbst antwortet.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/_explorer/anmeldung || exit 1
