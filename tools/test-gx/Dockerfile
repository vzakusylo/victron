FROM nodered/node-red:latest
USER root
RUN apk add --no-cache --upgrade openssh openssh-server bash curl \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
# Same layout as the GX: /data/home/nodered/.node-red and /data/home/nodered/tools
RUN mkdir -p /data/home/nodered/.node-red /data/home/nodered/tools /data/home/nodered/grid-control-config \
 && cd /data/home/nodered/.node-red \
 && npm install --no-audit --no-fund node-red-dashboard @victronenergy/node-red-contrib-victron node-red-contrib-tuya-smart-device
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
