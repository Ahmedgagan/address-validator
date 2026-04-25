# Use a slim version of Node for better performance/smaller size
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (better for caching layers)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
