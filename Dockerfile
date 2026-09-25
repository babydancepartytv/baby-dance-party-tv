FROM node:24-slim
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
