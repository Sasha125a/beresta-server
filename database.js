const { Pool } = require('pg');
require('dotenv').config();

// Используем Pool вместо Client для управления соединениями
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // максимальное количество клиентов в пуле
  idleTimeoutMillis: 30000, // закрыть соединения после 30 секунд бездействия
  connectionTimeoutMillis: 2000, // таймаут подключения 2 секунды
});

// Функция для подключения к БД и создания таблиц
async function initializeDB() {
  try {
    // Проверяем подключение
    const client = await pool.connect();
    console.log('✅ Подключение к PostgreSQL установлено');
    
    // Создание таблиц
    await createTables(client);
    
    // Освобождаем клиента обратно в пул
    client.release();
    
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error);
    process.exit(1);
  }
}

// Функция для создания таблиц
async function createTables(client) {
  try {
    const queries = [
      // Таблица пользователей
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Таблица друзей
      `CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email)
      )`,

      // Таблица сообщений
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

      // Таблица групп
      `CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Таблица участников групп
      `CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_email)
      )`,

      // Таблица групповых сообщений
      `CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        sender_email TEXT NOT NULL,
        message TEXT DEFAULT '',
        attachment_type TEXT DEFAULT '',
        attachment_filename TEXT DEFAULT '',
        attachment_original_name TEXT DEFAULT '',
        attachment_mime_type TEXT DEFAULT '',
        attachment_size INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        thumbnail TEXT DEFAULT '',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Таблица звонков
      `CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        call_id TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ended',
        duration INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      )`,

      // Таблица Agora звонков
      `CREATE TABLE IF NOT EXISTS agora_calls (
        id SERIAL PRIMARY KEY,
        channel_name TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      )`,

      // Индексы
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_downloads ON messages(downloaded_by_sender, downloaded_by_receiver)`,
      `CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id, user_email)`
    ];

    for (const query of queries) {
      await client.query(query);
    }
    
    console.log('✅ Все таблицы созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error);
    throw error;
  }
}

// Вспомогательные функции для работы с БД
const db = {
  // Выполнить запрос с параметрами
  query: (text, params) => pool.query(text, params),
  
  // Получить одну запись
  get: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows[0];
  },
  
  // Получить все записи
  all: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows;
  },
  
  // Выполнить запрос без возврата данных
  run: async (text, params) => {
    await pool.query(text, params);
  },
  
  // Получить клиента из пула (для транзакций)
  getClient: () => pool.connect()
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка пула соединений...');
  await pool.end();
  process.exit(0);
});

module.exports = { initializeDB, db, pool };
