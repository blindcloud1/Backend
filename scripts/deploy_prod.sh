set -euo pipefail

cd /opt/blindscloud/Backend

docker compose down
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

