FROM node:20-slim

WORKDIR /usr/src/app

# Copy package files from the current directory (which will be /app)
COPY package*.json ./

RUN npm install

# Copy everything else from the current directory
COPY . .

# Explicitly check if server.js exists during build (for debugging)
RUN ls -la

EXPOSE 3000

CMD [ "node", "server.js" ]