FROM node:22-alpine
WORKDIR /app

# Aucune dépendance : on copie simplement le code.
COPY package.json ./
COPY server.js cli.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

USER node
CMD ["node", "server.js"]
