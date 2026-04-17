"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
const amqp = __importStar(require("amqplib"));
class EventBus {
    connection = null;
    channel = null;
    config;
    constructor(config) {
        this.config = config;
    }
    async connect() {
        if (this.connection && this.channel)
            return;
        this.connection = await amqp.connect(this.config.url);
        this.channel = await this.connection.createChannel();
        await this.channel.assertExchange(this.config.exchange, 'topic', { durable: true });
    }
    async publish(routingKey, event) {
        if (!this.channel)
            throw new Error('EventBus not connected');
        const body = Buffer.from(JSON.stringify(event), 'utf8');
        this.channel.publish(this.config.exchange, routingKey, body, {
            contentType: 'application/json',
            persistent: true
        });
    }
    async subscribe(opts) {
        if (!this.channel)
            throw new Error('EventBus not connected');
        const { queueName, routingKeys, onMessage } = opts;
        await this.channel.assertQueue(queueName, {
            durable: true
        });
        for (const key of routingKeys) {
            await this.channel.bindQueue(queueName, this.config.exchange, key);
        }
        await this.channel.consume(queueName, async (msg) => {
            if (!msg)
                return;
            try {
                const parsed = JSON.parse(msg.content.toString('utf8'));
                await onMessage(parsed);
                this.channel?.ack(msg);
            }
            catch (err) {
                this.channel?.nack(msg, false, true);
            }
        });
    }
    async close() {
        try {
            await this.channel?.close();
        }
        finally {
            await this.connection?.close();
        }
        this.channel = null;
        this.connection = null;
    }
}
exports.EventBus = EventBus;
