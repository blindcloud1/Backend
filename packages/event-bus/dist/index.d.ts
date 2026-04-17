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
export declare class EventBus {
    private connection;
    private channel;
    private readonly config;
    constructor(config: EventBusConfig);
    connect(): Promise<void>;
    publish<TPayload>(routingKey: string, event: CloudEvent<TPayload>): Promise<void>;
    subscribe<TPayload>(opts: {
        queueName: string;
        routingKeys: string[];
        onMessage: (event: CloudEvent<TPayload>) => Promise<void>;
    }): Promise<void>;
    close(): Promise<void>;
}
