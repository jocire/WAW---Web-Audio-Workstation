# Use Node.js official image as base
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install a simple HTTP server to serve the static files
RUN npm install -g http-server

# Copy all application files
COPY . .

# Expose port (default for http-server is 8080, but we'll use 8000)
EXPOSE 8000

# Start the HTTP server
CMD ["http-server", "-p", "8000", "-c-1", "--cors"]
