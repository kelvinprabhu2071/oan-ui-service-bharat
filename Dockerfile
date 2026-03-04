# Stage 1: Build
FROM node:22.17.1-alpine AS build

WORKDIR /usr/local/app

# Declare build args BEFORE they are used
ARG VITE_API_URL
ARG VITE_BYPASS_AUTH
ARG VITE_BYPASS_AUTH_MOBILE
ARG VITE_BYPASS_AUTH_NAME
ARG VITE_BYPASS_AUTH_ROLE
ARG VITE_TELEMETRY_HOST

# Expose them as ENV so Vite picks them up during `npm run build`
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_BYPASS_AUTH=$VITE_BYPASS_AUTH
ENV VITE_BYPASS_AUTH_MOBILE=$VITE_BYPASS_AUTH_MOBILE
ENV VITE_BYPASS_AUTH_NAME=$VITE_BYPASS_AUTH_NAME
ENV VITE_BYPASS_AUTH_ROLE=$VITE_BYPASS_AUTH_ROLE
ENV VITE_TELEMETRY_HOST=$VITE_TELEMETRY_HOST

COPY package.json ./
RUN npm install

COPY ./ ./
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

WORKDIR /usr/share/nginx/html
COPY --from=build /usr/local/app/dist .
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8081

CMD ["nginx", "-g", "daemon off;"]

# docker build --platform linux/amd64 -t oan-ui-service-latest .
# docker save oan-ui-service-latest > oan-ui-service-latest.tar