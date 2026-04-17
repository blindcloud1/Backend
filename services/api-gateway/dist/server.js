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
app.use('/api/auth', (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
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
app.use('/api', (_req, res) => {
    res.status(501).json({ error: 'Not implemented in gateway yet' });
});
app.listen(PORT, '0.0.0.0', () => {
    void 0;
});
