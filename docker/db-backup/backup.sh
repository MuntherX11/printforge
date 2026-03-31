#!/bin/bash
set -euo pipefail

BACKUP_DIR="/backups"
RETENTION_DAYS=7

echo "PrintForge DB backup service started"
echo "Backups stored in: ${BACKUP_DIR}"
echo "Retention: ${RETENTION_DAYS} days"

while true; do
    TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
    BACKUP_FILE="${BACKUP_DIR}/printforge_${TIMESTAMP}.sql.gz"

    echo "[$(date)] Starting backup..."

    if pg_dump -h "${PGHOST}" -U "${PGUSER}" "${PGDATABASE}" | gzip > "${BACKUP_FILE}"; then
        echo "[$(date)] Backup completed: ${BACKUP_FILE}"
        echo "[$(date)] Size: $(du -h "${BACKUP_FILE}" | cut -f1)"
    else
        echo "[$(date)] ERROR: Backup failed"
        rm -f "${BACKUP_FILE}"
    fi

    # Remove backups older than retention period
    echo "[$(date)] Cleaning up backups older than ${RETENTION_DAYS} days..."
    find "${BACKUP_DIR}" -name "printforge_*.sql.gz" -type f -mtime +${RETENTION_DAYS} -delete

    REMAINING=$(find "${BACKUP_DIR}" -name "printforge_*.sql.gz" -type f | wc -l)
    echo "[$(date)] ${REMAINING} backup(s) on disk"

    # Sleep 24 hours
    echo "[$(date)] Next backup in 24 hours"
    sleep 86400
done
