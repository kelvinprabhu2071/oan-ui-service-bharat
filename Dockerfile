# Stage 1: Build
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Declare build args BEFORE they are used
ARG VITE_API_URL
ARG VITE_BYPASS_AUTH
ARG VITE_BYPASS_AUTH_MOBILE
ARG VITE_BYPASS_AUTH_NAME
ARG VITE_BYPASS_AUTH_ROLE
ARG VITE_TELEMETRY_HOST

# Expose them as ENV so Vite picks them up during `bun run build`
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_BYPASS_AUTH=$VITE_BYPASS_AUTH
ENV VITE_BYPASS_AUTH_MOBILE=$VITE_BYPASS_AUTH_MOBILE
ENV VITE_BYPASS_AUTH_NAME=$VITE_BYPASS_AUTH_NAME
ENV VITE_BYPASS_AUTH_ROLE=$VITE_BYPASS_AUTH_ROLE
ENV VITE_TELEMETRY_HOST=$VITE_TELEMETRY_HOST

COPY package.json bun.lockb ./
RUN bun install

COPY . .
RUN bun run build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8081

CMD ["nginx", "-g", "daemon off;"]