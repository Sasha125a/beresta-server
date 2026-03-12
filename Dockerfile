FROM node:22-alpine

WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости — используем npm install вместо npm ci
RUN npm install --only=production

# Копируем остальной код
COPY . .

# Экспонируем порт (укажите нужный порт)
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]
