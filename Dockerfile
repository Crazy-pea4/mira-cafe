FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# .dockerignore permits only application, build and test inputs.
COPY . .
RUN mkdir -p /var/lib/mira-cafe

ENV MIRA_DEV_HOST=0.0.0.0 \
    MIRA_STATE_DIR=/var/lib/mira-cafe \
    MIRA_ENABLE_LIVE_APIS=false \
    MIRA_PROVIDER=mock \
    MIRA_SPEECH_PROVIDER=mock \
    MIRA_MEDIA_PROVIDER=disabled \
    MIRA_ENABLE_MEDIA_APIS=false

EXPOSE 5173
CMD ["npm", "run", "dev"]
