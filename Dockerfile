FROM node:20-slim

# Build tools needed to compile better-sqlite3 native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
# DB_PATH is set via Railway environment variable / volume mount
ENV DB_PATH=/data/tracker.db

EXPOSE 3000

CMD ["node", "dist/index.js"]
