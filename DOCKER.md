# EasyDAW Docker Setup

This directory now includes Docker configuration for containerizing the EasyDAW application.

## Files Added

- **Dockerfile** - Docker image configuration
- **docker-compose.yml** - Docker Compose configuration for easy local development
- **.dockerignore** - Files to exclude from Docker build

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up --build

# The app will be available at http://localhost:8100 (host port 8100 -> container 8000)
```

### Using Docker directly

```bash
# Build the image
docker build -t easydaw .

# Run the container
docker run -p 8100:8000 -v $(pwd):/app easydaw
```

## Environment

- **Base Image**: Node.js 18 Alpine (lightweight)
- **Server**: http-server (simple static file server)
- **Port**: 8000
- **CORS**: Enabled for development

## Development

When running with docker-compose, the current directory is mounted as a volume (`-v`), so changes to files are reflected immediately without rebuilding.

## Production Deployment

For production, consider using:
- **Nginx** or **Apache** for better performance
- Remove the volume mount to avoid exposing source code
- Use environment-specific configurations
- Add health checks
- Implement proper logging and monitoring

Example production Dockerfile:

```dockerfile
FROM node:18-alpine as builder
WORKDIR /app
COPY . .

FROM nginx:alpine
COPY --from=builder /app /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```
