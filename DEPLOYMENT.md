# Deployment (VPS)

## Goal

Run the backend on the VPS without rebuilding on the VPS (GitHub Actions builds images, VPS pulls and restarts).

## Step 1: Push to `main`

On your local machine:

```bash
git add .
git commit -m "backend updates"
git push origin main
```

## Step 2: Confirm Docker images are published

In GitHub:
- Repo → Actions → `Docker Publish` workflow → make sure it succeeded.

This publishes images to GHCR:
- `ghcr.io/blindcloud1/blindscloud-api-gateway:latest`
- `ghcr.io/blindcloud1/blindscloud-auth-service:latest`
- `ghcr.io/blindcloud1/blindscloud-users-service:latest`
- `ghcr.io/blindcloud1/blindscloud-businesses-service:latest`
- `ghcr.io/blindcloud1/blindscloud-customers-service:latest`
- `ghcr.io/blindcloud1/blindscloud-jobs-service:latest`
- `ghcr.io/blindcloud1/blindscloud-products-service:latest`
- `ghcr.io/blindcloud1/blindscloud-pricing-service:latest`
- `ghcr.io/blindcloud1/blindscloud-billing-service:latest`
- `ghcr.io/blindcloud1/blindscloud-notifications-service:latest`
- `ghcr.io/blindcloud1/blindscloud-files-service:latest`

## Step 3: Configure `.env` on VPS

Create/update `/opt/blindscloud/Backend/.env`:

```bash
JWT_SECRET=change-this-to-a-long-random-string
MONGO_ROOT_USER=admin
MONGO_ROOT_PASSWORD=change-me
RABBITMQ_USER=admin
RABBITMQ_PASSWORD=change-me
CORS_ORIGINS=http://localhost:5173
FILES_BASE_URL=
```

## Step 4: Deploy on VPS using published images

```bash
cd /opt/blindscloud/Backend
docker compose down
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker ps
```

## Step 5: Health checks

```bash
curl -sS http://localhost:3001/health
curl -sS http://localhost:3001/api/auth/health
curl -sS http://localhost:3001/api/users/health
curl -sS http://localhost:3001/api/businesses/health
curl -sS http://localhost:3001/api/customers/health
curl -sS http://localhost:3001/api/jobs/health
curl -sS http://localhost:3001/api/products/health
curl -sS http://localhost:3001/api/pricing-tables/health
curl -sS http://localhost:3001/api/billing/health
curl -sS http://localhost:3001/api/notifications/health
curl -sS http://localhost:3001/api/files/health
```

## Notes

- If GHCR images are private, the VPS must login to GHCR before pulling:
  - `docker login ghcr.io`
- Data persistence is via Docker volumes:
  - `mongo-data` for MongoDB
  - `uploads-data` for uploaded files

