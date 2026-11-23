ARG NODERED_VERSION=3.1.15
FROM nodered/node-red:${NODERED_VERSION}
USER root
RUN apk add --no-cache --upgrade openssh openssh-server bash curl python3 py3-dbus \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
# Alpine 3.18 has no libfaketime package. Build a pinned musl-compatible upstream release;
# only the multithreaded runtime library is retained in the image.
RUN apk add --no-cache --virtual .faketime-build-deps build-base git \
 && git clone --depth 1 --branch v0.9.13 https://github.com/wolfcw/libfaketime /tmp/libfaketime \
 && make -C /tmp/libfaketime \
 && install -D -m 755 /tmp/libfaketime/src/libfaketimeMT.so.1 /usr/local/lib/faketime/libfaketimeMT.so.1 \
 && apk del .faketime-build-deps \
 && rm -rf /tmp/libfaketime
# The default context is the committed synthetic fixture; -Backup still accepts sanitized trees.
# PALETTE is supplied by up.ps1 only for sanitized backups.
ARG PALETTE=""
COPY --from=backup nodered/ /data/home/nodered/
RUN mkdir -p /data/home/nodered/tools /data/home/nodered/grid-control-config /data/home/nodered/grid-control-logs \
 && cd /data/home/nodered/.node-red \
 && if [ -f ../package.json ]; then cp ../package.json package.json; fi \
 && npm install --no-audit --no-fund --no-package-lock ${PALETTE}
COPY entrypoint.sh /entrypoint.sh
# the base image checks /data/settings.js; our userDir is /data/home/nodered/.node-red
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 CMD curl -fs http://127.0.0.1:1880/ -o /dev/null || exit 1
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
