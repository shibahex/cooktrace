#!/bin/sh
set -eu

for file_var in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*_FILE\)=.*/\1/p'); do
  var_name=${file_var%_FILE}
  file_path=$(eval "printf '%s' \"\${$file_var}\"")
  var_value=$(eval "printf '%s' \"\${$var_name-}\"")

  if [ -n "$var_value" ]; then
    echo "error: both $var_name and $file_var are set; use only one" >&2
    exit 1
  fi

  if [ -z "$file_path" ]; then
    echo "error: $file_var is set but empty" >&2
    exit 1
  fi

  if [ ! -r "$file_path" ]; then
    echo "error: cannot read secret file for $var_name at $file_path" >&2
    exit 1
  fi

  export "$var_name=$(cat "$file_path")"
  unset "$file_var"
done

# ourfamily fork: don't run the app as root. If anything in it were ever
# made to run code, it would have the container's root. Hand the data
# folders to the unprivileged `node` user (only when they aren't already
# its, so a big uploads folder isn't walked on every start), then drop to
# it. RUN_AS_ROOT=1 keeps the old behaviour.
if [ "$(id -u)" = "0" ] && [ "${RUN_AS_ROOT:-}" != "1" ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
  node_uid=$(id -u node)
  for dir in "$(dirname "${DB_PATH:-/app/cooktrace.db}")" "${UPLOADS_PATH:-/app/uploads}" ${BACKUPS_PATH:+"$BACKUPS_PATH"}; do
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "$node_uid" ]; then
      echo "[entrypoint] giving $dir to the node user"
      chown -R node:node "$dir"
    fi
  done
  exec su-exec node "$@"
fi

exec "$@"
