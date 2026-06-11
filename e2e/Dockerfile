FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /e2e
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npx", "playwright", "test", "--reporter=list,html"]
