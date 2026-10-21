#!/bin/bash
# SQLite 在线热备份（WAL 模式下安全）：保留最近 14 份。可放进 crontab：0 3 * * * /path/scripts/backup.sh
cd "$(dirname "$0")/.."; mkdir -p backups
DB=$(grep -E '^DB_FILE=' .env 2>/dev/null | cut -d= -f2); DB=${DB:-$(ls -1 ./data/*.db 2>/dev/null | head -1)}
OUT=backups/db-$(date +%Y%m%d-%H%M%S).db
node -e "const D=require('better-sqlite3');new D(process.argv[1],{readonly:true}).backup(process.argv[2]).then(()=>console.log('backup ->',process.argv[2]))" "$DB" "$OUT"
ls -1t backups/db-*.db | tail -n +15 | xargs -r rm --
