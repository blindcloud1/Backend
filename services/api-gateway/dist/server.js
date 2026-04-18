"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const http_proxy_middleware_1 = require("http-proxy-middleware");
dotenv_1.default.config();
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
const ORDERS_SERVICE_URL = process.env.ORDERS_SERVICE_URL || 'http://localhost:4011';
const DEMO_REQUESTS_SERVICE_URL = process.env.DEMO_REQUESTS_SERVICE_URL || 'http://localhost:4012';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const app = (0, express_1.default)();
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : true,
    credentials: true
}));
app.get('/health', (_req, res) => {
    res.json({ status: 'OK', service: 'api-gateway' });
});
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/auth',
    pathRewrite: { '^/api/auth': '/auth' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: USERS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/users',
    pathRewrite: { '^/api/users': '/users' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: BUSINESSES_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/businesses',
    pathRewrite: { '^/api/businesses': '/businesses' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: CUSTOMERS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/customers',
    pathRewrite: { '^/api/customers': '/customers' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: JOBS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/jobs',
    pathRewrite: { '^/api/jobs': '/jobs' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: PRODUCTS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/products',
    pathRewrite: { '^/api/products': '/products' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: PRICING_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/pricing-tables',
    pathRewrite: { '^/api/pricing-tables': '/pricing-tables' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: BILLING_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/billing',
    pathRewrite: { '^/api/billing': '' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: NOTIFICATIONS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/notifications',
    pathRewrite: { '^/api/notifications': '/notifications' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: NOTIFICATIONS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/push-subscriptions',
    pathRewrite: { '^/api/push-subscriptions': '/push-subscriptions' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: FILES_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/files',
    pathRewrite: { '^/api/files': '/files' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: ORDERS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/orders',
    pathRewrite: { '^/api/orders': '/orders' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
    target: DEMO_REQUESTS_SERVICE_URL,
    changeOrigin: true,
    pathFilter: '/api/demo-requests',
    pathRewrite: { '^/api/demo-requests': '/demo-requests' },
    on: {
        proxyReq: (proxyReq, req, _res) => {
            const correlationId = req.headers['x-correlation-id'];
            if (correlationId && typeof correlationId === 'string') {
                proxyReq.setHeader('x-correlation-id', correlationId);
            }
        }
    }
}));
app.use('/api', (_req, res) => {
    res.status(501).json({ error: 'Not implemented in gateway yet' });
});
app.listen(PORT, '0.0.0.0', () => {
    void 0;
});
