# ---- build web ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/node_modules ./node_modules
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
