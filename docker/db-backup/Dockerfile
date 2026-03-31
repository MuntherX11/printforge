FROM postgres:16-alpine

RUN apk add --no-cache bash

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

RUN mkdir -p /backups

CMD ["/usr/local/bin/backup.sh"]
