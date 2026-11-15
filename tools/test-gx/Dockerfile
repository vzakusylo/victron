ARG NODERED_VERSION=latest
FROM nodered/node-red:${NODERED_VERSION}
USER root
RUN apk add --no-cache --upgrade openssh openssh-server bash curl \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
# Same layout as the GX. BACKUP is a sanitized tree from sanitize-backup.js (build context "backup"):
# its nodered/ folder becomes /data/home/nodered. PALETTE is "name@version name@version ...".
ARG PALETTE="node-red-dashboard @victronenergy/node-red-contrib-victron node-red-contrib-tuya-smart-device"
COPY --from=backup nodered/ /data/home/nodered/
RUN mkdir -p /data/home/nodered/tools /data/home/nodered/grid-control-config /data/home/nodered/grid-control-logs \
 && cd /data/home/nodered/.node-red \
 && npm install --no-audit --no-fund --no-package-lock ${PALETTE}
COPY entrypoint.sh /entrypoint.sh
# the base image checks /data/settings.js; our userDir is /data/home/nodered/.node-red
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 CMD curl -fs http://127.0.0.1:1880/ -o /dev/null || exit 1
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
