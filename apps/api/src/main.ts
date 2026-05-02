import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers (X-Frame-Options, CSP, HSTS, etc.)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // allow loading images
  }));

  // CORS — allow frontend origin only; never fall back to wildcard
  const allowedOrigin = process.env.CORS_ORIGIN || 'https://printforge.mctx.tech';
  app.enableCors({
    origin: allowedOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  });

  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const port = process.env.API_PORT || 4000;
  // API_HOST defaults to 127.0.0.1 so nginx is the only entry point in production.
  // Set API_HOST=0.0.0.0 in .env for Docker or direct-access dev setups.
  // 0.0.0.0 is the correct default for Docker Compose (nginx is a separate container).
  // Set API_HOST=127.0.0.1 only when nginx and the API share a network namespace (same host, no Docker).
  const host = process.env.API_HOST || '0.0.0.0';
  await app.listen(port, host);
  new Logger('Bootstrap').log(`PrintForge API running on ${host}:${port}`);
}
bootstrap();
