import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'http';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001', 10);
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
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

app.use(
  '/api/auth',
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/auth': '/auth' },
    on: {
      proxyReq: (proxyReq: ClientRequest, req: IncomingMessage, _res: ServerResponse) => {
        const correlationId = req.headers['x-correlation-id'];
        if (correlationId && typeof correlationId === 'string') {
          proxyReq.setHeader('x-correlation-id', correlationId);
        }
      }
    }
  })
);

app.use('/api', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented in gateway yet' });
});

app.listen(PORT, '0.0.0.0', () => {
  void 0;
});
