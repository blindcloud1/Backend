import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'http';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001', 10);
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
const USERS_SERVICE_URL = process.env.USERS_SERVICE_URL || 'http://localhost:4002';
const BUSINESSES_SERVICE_URL = process.env.BUSINESSES_SERVICE_URL || 'http://localhost:4003';
const CUSTOMERS_SERVICE_URL = process.env.CUSTOMERS_SERVICE_URL || 'http://localhost:4004';
const JOBS_SERVICE_URL = process.env.JOBS_SERVICE_URL || 'http://localhost:4005';
const PRODUCTS_SERVICE_URL = process.env.PRODUCTS_SERVICE_URL || 'http://localhost:4006';
const PRICING_SERVICE_URL = process.env.PRICING_SERVICE_URL || 'http://localhost:4007';
const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || 'http://localhost:4008';
const NOTIFICATIONS_SERVICE_URL = process.env.NOTIFICATIONS_SERVICE_URL || 'http://localhost:4009';
const FILES_SERVICE_URL = process.env.FILES_SERVICE_URL || 'http://localhost:4010';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(helmet());
app.use(cors({
  origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : true,
  credentials: true
}));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', service: 'api-gateway' });
});

app.use(createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/auth',
  pathRewrite: { '^/api/auth': '/auth' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: USERS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/users',
  pathRewrite: { '^/api/users': '/users' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: BUSINESSES_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/businesses',
  pathRewrite: { '^/api/businesses': '/businesses' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: CUSTOMERS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/customers',
  pathRewrite: { '^/api/customers': '/customers' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: JOBS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/jobs',
  pathRewrite: { '^/api/jobs': '/jobs' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: PRODUCTS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/products',
  pathRewrite: { '^/api/products': '/products' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: PRICING_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/pricing-tables',
  pathRewrite: { '^/api/pricing-tables': '/pricing-tables' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: BILLING_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/billing',
  pathRewrite: { '^/api/billing': '' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: NOTIFICATIONS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/notifications',
  pathRewrite: { '^/api/notifications': '/notifications' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: NOTIFICATIONS_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/push-subscriptions',
  pathRewrite: { '^/api/push-subscriptions': '/push-subscriptions' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use(createProxyMiddleware({
  target: FILES_SERVICE_URL,
  changeOrigin: true,
  pathFilter: '/api/files',
  pathRewrite: { '^/api/files': '/files' },
  on: {
    proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
      const correlationId = req.headers['x-correlation-id'];
      if (correlationId && typeof correlationId === 'string') {
        proxyReq.setHeader('x-correlation-id', correlationId);
      }
    }
  }
}));

app.use('/api', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented in gateway yet' });
});

app.listen(PORT, '0.0.0.0', () => {
  void 0;
});
