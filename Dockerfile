# Stage 1: Build
FROM node:22.22.1-alpine AS build
WORKDIR /usr/local/app
COPY package.json ./
RUN npm install
COPY ./ ./
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
WORKDIR /usr/share/nginx/html
COPY --from=build /usr/local/app/dist .
# Add nginx config for SPA routing
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8081
CMD ["nginx", "-g", "daemon off;"]

# docker build --platform linux/amd64 -t vistaar-ui-service-latest .
# docker save vistaar-ui-service-latest > vistaar-ui-service-latest.tar