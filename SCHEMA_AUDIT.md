# Schema Audit (SQL migrations → MongoDB collections)

This backend stores data in MongoDB. Each SQL “table” from the original migrations maps to a MongoDB collection and a TypeScript document model in `@blindscloud/models`.

## Key notes

- SQL uses `snake_case` columns; Mongo uses `camelCase` fields in code.
- SQL `uuid` maps to Mongo `_id: string` (uuid string).
- SQL `created_at/updated_at` maps to `createdAt/updatedAt` (Mongo `Date`).
- SQL `jsonb` columns map to `Record<string, unknown>` (or arrays) in the models.

## User roles (admin / business / employee / merchant)

- Roles are: `admin`, `business`, `employee`, `merchant`
- Business-scoped roles: `business`, `employee`, `merchant` must have `businessId`.
- `employee` and `merchant` must have a `parentId` (the creator/manager).

Enforced in: `POST /users` in the users service.

## Table mapping

| SQL table (migrations) | Mongo collection | Model | Service + Gateway route |
|---|---|---|---|
| `users` | `users` | `UserDoc` | users-service → `/api/users/*` |
| `businesses` | `businesses` | `BusinessDoc` | businesses-service → `/api/businesses/*` |
| `business_settings` | `business_settings` | `BusinessSettingsDoc` | businesses-service → `/api/businesses/:id/settings` |
| `customers` | `customers` | `CustomerDoc` | customers-service → `/api/customers/*` |
| `jobs` | `jobs` | `JobDoc` | jobs-service → `/api/jobs/*` |
| `measurements` | `measurements` | `MeasurementDoc` | jobs-service → `/api/jobs/:id/measurements` |
| `images` | `images` | `JobImageDoc` | jobs-service → `/api/jobs/:id/images` |
| `products` | `products` | `ProductDoc` | products-service → `/api/products/*` |
| `pricing_tables` | `pricing_tables` | `PricingTableDoc` | pricing-service → `/api/pricing-tables/*` |
| `subscription_plans` | `subscription_plans` | `SubscriptionPlanDoc` | billing-service → `/api/billing/subscription-plans*` |
| `user_subscriptions` | `user_subscriptions` | `UserSubscriptionDoc` | billing-service → `/api/billing/subscriptions*` |
| `payment_history` | `payment_history` | `PaymentHistoryDoc` | billing-service → `/api/billing/payments*` |
| `custom_plan_config` | `custom_plan_config` | `CustomPlanConfigDoc` | billing-service → `/api/billing/custom-plan-config` |
| `notifications` | `notifications` | `NotificationDoc` | notifications-service → `/api/notifications/*` |
| `push_subscriptions` | `push_subscriptions` | `PushSubscriptionDoc` | notifications-service → `/api/push-subscriptions/*` |
| `orders` | `orders` | `OrderDoc` | orders-service → `/api/orders/*` |
| `demo_requests` | `demo_requests` | `DemoRequestDoc` | demo-requests-service → `/api/demo-requests/*` |
| `files` (Mongo-only metadata) | `files` | `FileDoc` | files-service → `/api/files/*` |
| `module_permissions` | `module_permissions` | `ModulePermissionDoc` | module-permissions-service → `/api/module-permissions/*` |
| `models_3d` | `models_3d` | `Model3DDoc` | models3d-service → `/api/models-3d/*` |
| `model_permissions` | `model_permissions` | `ModelPermissionDoc` | model-permissions-service → `/api/model-permissions/*` |
| `activity_logs` | `activity_logs` | `ActivityLogDoc` | activity-logs-service → `/api/activity-logs/*` |
| `user_sessions` | `user_sessions` | `UserSessionDoc` | user-sessions-service → `/api/sessions/*` |
