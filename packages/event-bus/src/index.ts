import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

export type CloudEvent<TPayload> = {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: string;
  correlationId?: string;
  payload: TPayload;
};

export type EventBusConfig = {
  url: string;
  exchange: string;
  serviceName: string;
};

export class EventBus {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly config: EventBusConfig;

  constructor(config: EventBusConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connection && this.channel) return;

    this.connection = await amqp.connect(this.config.url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(this.config.exchange, 'topic', { durable: true });
  }

  async publish<TPayload>(routingKey: string, event: CloudEvent<TPayload>): Promise<void> {
    if (!this.channel) throw new Error('EventBus not connected');
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    this.channel.publish(this.config.exchange, routingKey, body, {
      contentType: 'application/json',
      persistent: true
    });
  }

  async subscribe<TPayload>(opts: {
    queueName: string;
    routingKeys: string[];
    onMessage: (event: CloudEvent<TPayload>) => Promise<void>;
  }): Promise<void> {
    if (!this.channel) throw new Error('EventBus not connected');

    const { queueName, routingKeys, onMessage } = opts;

    await this.channel.assertQueue(queueName, {
      durable: true
    });

    for (const key of routingKeys) {
      await this.channel.bindQueue(queueName, this.config.exchange, key);
    }

    await this.channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        const parsed = JSON.parse(msg.content.toString('utf8')) as CloudEvent<TPayload>;
        await onMessage(parsed);
        this.channel?.ack(msg);
      } catch (err) {
        this.channel?.nack(msg, false, true);
      }
    });
  }

  async close(): Promise<void> {
    try {
      await this.channel?.close();
    } finally {
      await this.connection?.close();
    }
    this.channel = null;
    this.connection = null;
  }
}
