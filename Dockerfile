FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# The server uses only Node.js built-ins; no dependency installation is needed.
COPY --chown=node:node package.json mimo_server.js ./
COPY --chown=node:node lib/ ./lib/

RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "-e", "const fs=require('fs');let port=3000;for (const p of ['/app/config/config.toml','/app/config.toml']){try{const t=fs.readFileSync(p,'utf8');const m=/^port\\s*=\\s*(\\d+)/m.exec(t);if(m){port=m[1];break;}}catch{}}fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "mimo_server.js"]
