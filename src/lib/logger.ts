import pino from "pino";
import pretty from "pino-pretty";

const stream = pretty({
  colorize: true,
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
  ignore: "pid,hostname",
  // Flush writes synchronously so fatal logs are not lost when the process
  // exits right after logging (crash handlers call process.exit).
  sync: true,
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "news-telegram-agent" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  stream,
);
