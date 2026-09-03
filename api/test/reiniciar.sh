#!/usr/bin/env bash
# Reinicia la base local, siembra un administrador y deja el Worker
# corriendo en el puerto 8787. Imprime la clave temporal del admin.
#
#   CLAVE=$(bash test/reiniciar.sh)
#   node test/api.test.mjs "$CLAVE" /tmp/caech-wrangler.log
set -e
cd "$(dirname "$0")/.."

# Cortar el Worker anterior. En Windows wrangler lanza un `workerd` hijo
# que sobrevive a matar al padre y sigue reteniendo los .sqlite de
# miniflare: si no se matan los dos, `rm -rf .wrangler/state` falla con
# "Device or resource busy".
detener() {
    if command -v powershell.exe > /dev/null 2>&1; then
        powershell.exe -NoProfile -Command "
            Get-Process workerd -ErrorAction SilentlyContinue | Stop-Process -Force
            Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
                Where-Object { \$_.CommandLine -match 'wrangler' } |
                ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }
        " > /dev/null 2>&1 || true
    else
        pkill -f "wrangler dev" > /dev/null 2>&1 || true
        pkill -f workerd > /dev/null 2>&1 || true
    fi
    sleep 2
}

detener
rm -rf .wrangler/state

npx wrangler d1 execute caech-afiliados --local --file=schema.sql > /dev/null 2>&1
node scripts/crear-admin.mjs --usuario admin --correo admin@cae-ch.org.ec \
     --nombre "Administrador CAE-CH" --iteraciones 50000 > /tmp/caech-admin.txt 2>&1
grep -m1 "^INSERT INTO" /tmp/caech-admin.txt > /tmp/caech-admin.sql
npx wrangler d1 execute caech-afiliados --local --file=/tmp/caech-admin.sql > /dev/null 2>&1

rm -f /tmp/caech-wrangler.log
npx wrangler dev --port 8787 --local > /tmp/caech-wrangler.log 2>&1 &
for i in $(seq 1 40); do
    sleep 1
    grep -q "Ready on" /tmp/caech-wrangler.log && break
done

grep "CLAVE TEMPORAL" /tmp/caech-admin.txt | sed 's/.*: //'
