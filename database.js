const { Client } = require('pg');
require('dotenv').config();

// Подключение к PostgreSQL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Функция для подключения к БД
async function connectDB() {
  try {
    await client.connect();
    console.log('✅ Подключение к PostgreSQL установлено');
    
    // Создание таблиц
    await createTables();
    
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error);
    process.exit(1);
  }
}

// Функция для создания таблиц
async function createTables() {
  try {
    // Все ваши CREATE TABLE запросы из текущего кода
    // Нужно преобразовать их в PostgreSQL синтаксис
    const queries = [
      `CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email)
      )`,
      
      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        message TEXT DEFAULT '',
        attachment_type TEXT DEFAULT '',
        attachment_filename TEXT DEFAULT '',
        attachment_original_name TEXT DEFAULT '',
        attachment_mime_type TEXT DEFAULT '',
        attachment_size INTEGER DEFAULT 0,
        attachment_url TEXT DEFAULT '',
        duration INTEGER DEFAULT 0,
        thumbnail TEXT DEFAULT '',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent',
        downloaded_by_sender BOOLEAN DEFAULT FALSE,
        downloaded_by_receiver BOOLEAN DEFAULT FALSE
      )`,
      
      // Добавьте все остальные таблицы аналогично...
      
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const query of queries) {
      await client.query(query);
    }
    
    console.log('✅ Таблицы созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error);
  }
}

module.exports = { client, connectDB };
