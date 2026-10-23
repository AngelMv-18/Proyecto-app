#!/usr/bin/env bash
# Copia de seguridad de la base de datos completa (pg_dump comprimido). Programa con cron, p. ej. a diario.
# Restaurar: gunzip -c backups/nova-AAAAMMDD.sql.gz | psql "$DATABASE_URL"
set -euo pipefail
: "${DATABASE_URL:?Define DATABASE_URL}"
mkdir -p backups
f="backups/nova-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner "$DATABASE_URL" | gzip > "$f"
find backups -name 'nova-*.sql.gz' -mtime +30 -delete
echo "Respaldo creado: $f"
