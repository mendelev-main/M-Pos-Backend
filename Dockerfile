FROM node:22-alpine
ARG MPOS_BUILD_SHA=unknown
LABEL org.opencontainers.image.revision=$MPOS_BUILD_SHA

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
