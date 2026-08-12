FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV DATA_PATH=/app/data
ENV CONFIG_PATH=/app/src/config/config.yaml
ENV TZ=Europe/Lisbon

CMD ["bun", "run", "src/main.ts"]
