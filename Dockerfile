FROM node:22-alpine

WORKDIR /app

# Сначала копируем ВСЕ файлы проекта
COPY . .

# Затем копируем package*.json отдельно (важно для кэширования слоёв)
COPY package*.json ./

# Устанавливаем системные зависимости для нативной компиляции
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    build-base

# Устанавливаем зависимости
RUN npm install --only=production

# Экспонируем порт (укажите нужный порт)
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]
