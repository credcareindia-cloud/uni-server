import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface LogLevel {
  ERROR: 0;
  WARN: 1;
  INFO: 2;
  DEBUG: 3;
}

const LOG_LEVELS: LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class Logger {
  private logLevel: number;
  private logStream?: NodeJS.WritableStream;

  constructor() {
    this.logLevel = this.getLogLevel();
    this.setupFileLogging();
  }

  private getLogLevel(): number {
    const level = process.env.LOG_LEVEL?.toUpperCase() || 'INFO';
    return LOG_LEVELS[level as keyof LogLevel] ?? LOG_LEVELS.INFO;
  }

  private setupFileLogging(): void {
    if (process.env.NODE_ENV === 'production') {
      const logsDir = join(process.cwd(), 'logs');
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      
      const logFile = join(logsDir, `app-${new Date().toISOString().split('T')[0]}.log`);
      this.logStream = createWriteStream(logFile, { flags: 'a' });
    }
  }

  private formatMessage(level: string, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  }

  private log(level: keyof LogLevel, message: string, meta?: any): void {
    if (LOG_LEVELS[level] > this.logLevel) return;

    const formattedMessage = this.formatMessage(level, message, meta);
    
    // Console output with colors
    if (process.env.NODE_ENV !== 'production') {
      const colors = {
        ERROR: '\x1b[31m', // Red
        WARN: '\x1b[33m',  // Yellow
        INFO: '\x1b[36m',  // Cyan
        DEBUG: '\x1b[35m'  // Magenta
      };
      const reset = '\x1b[0m';
      console.log(`${colors[level]}${formattedMessage}${reset}`);
    } else {
      console.log(formattedMessage);
    }

    // File output
    if (this.logStream) {
      this.logStream.write(formattedMessage + '\n');
    }
  }

  error(message: string, meta?: any): void {
    this.log('ERROR', message, meta);
  }

  warn(message: string, meta?: any): void {
    this.log('WARN', message, meta);
  }

  info(message: string, meta?: any): void {
    this.log('INFO', message, meta);
  }

  debug(message: string, meta?: any): void {
    this.log('DEBUG', message, meta);
  }
}

export const logger = new Logger();
