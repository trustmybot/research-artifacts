FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

WORKDIR /app
COPY allowlist-proxy.ts proxy-entry.ts /app/

USER node
ENTRYPOINT ["node", "/app/proxy-entry.ts"]
