#!/bin/bash
# 用临时数据库起一个测试实例并运行 E2E。端口：E2E_PORT（默认 3101）；
# 若已有实例在跑，可直接：BASE=http://localhost:3200 python3 test/e2e.py
cd "$(dirname "$0")/.."; T=$(mktemp -d); P0=${E2E_PORT:-3101}
# 行业若提供 test/clock.js（如现场排队依赖营业时间），默认把服务端时钟平移到今天 14:00，夜间也能跑通
PRE=""; [ -f test/clock.js ] && PRE="-r ./test/clock.js" && export FAKE_HM=${FAKE_HM:-14:00}
PORT=$P0 HOST=127.0.0.1 DB_FILE=$T/e2e.db SMS_PER_IP_HOUR=1000 LOG_LEVEL=warn node $PRE src/server.js > $T/server.log 2>&1 & P=$!
for i in $(seq 1 40); do curl -sf localhost:$P0/api/health >/dev/null && break; sleep 0.25; done
BASE=http://localhost:$P0 ${PY:-python3} test/e2e.py; code=$?
kill $P; [ $code -ne 0 ] && tail -20 $T/server.log; rm -rf $T; exit $code
