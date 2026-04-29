import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    transport: process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
  });
}
