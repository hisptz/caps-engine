import * as winston from "winston";
import type { ServiceType } from "@/shared/constants/service.ts";
import { getServiceName } from "@/shared/utils/service.ts";

export const logger = winston.createLogger({
  transports: [
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      format: winston.format.json(),
    }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

export const serviceLogger = {
  info(service: ServiceType, message: string) {
    logger.info(`[${getServiceName(service)}] ${message}`);
  },
  error(service: ServiceType, message: string) {
    logger.error(`[${getServiceName(service)}] ${message}`);
  },
  debug(service: ServiceType, message: string) {
    logger.debug(`[${getServiceName(service)}] ${message}`);
  },
  warn(service: ServiceType, message: string) {
    logger.warn(`[${getServiceName(service)}] ${message}`);
  },
};
