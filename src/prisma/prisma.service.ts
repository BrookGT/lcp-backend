import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    const maxAttempts = 5;
    let attempt = 0;
    // Simple exponential backoff for transient connectivity (e.g. cold-started Neon)
    while (attempt < maxAttempts) {
      try {
        attempt++;
        await this.$connect();
        if (attempt > 1) {
          this.logger.log(`Database connected after retry #${attempt - 1}`);
        } else {
          this.logger.log('Database connected');
        }
        return;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = (err as Error)?.message;
        const delay = 500 * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Database connection attempt ${attempt} failed: ${code || msg}.` +
            (attempt < maxAttempts
              ? ` Retrying in ${delay}ms...`
              : ' No more retries.'),
        );
        if (attempt >= maxAttempts) {
          this.logger.error(
            'Unable to establish database connection. Verify DATABASE_URL, network access, and that the remote instance is running.',
          );
          throw err;
        }
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
