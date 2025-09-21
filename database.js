const { Pool } = require('pg');
require('dotenv').config();

// Функция для проверки и корректировки строки подключения
function getCorrectedConnectionString() {
  let connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    throw new Error('DATABASE_URL не установлен в переменных окружения');
  }

  console.log('🔗 Исходная строка подключения:', connectionString);
  
  return connectionString;
}

// Создаем пул соединений
const pool = new Pool({
  connectionString: getCorrectedConnectionString(),
  ssl: {
    rejectUnauthorized: false
  },
  // Явно указываем использовать IPv4
  family: 4,
  // Таймауты
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

// Функция для проверки подключения
async function checkConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as db_version');
    console.log('✅ Подключение к PostgreSQL установлено');
    console.log('🕒 Время базы данных:', result.rows[0].current_time);
    console.log('🐘 Версия PostgreSQL:', result.rows[0].db_version);
    return true;
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
    console.log('🔍 Код ошибки:', error.code);
    return false;
  } finally {
    if (client) client.release();
  }
}

// Функция для создания таблиц
async function createTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Создание/проверка таблиц...');

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

      // Индексы для оптимизации
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_downloads ON messages(downloaded_by_sender, downloaded_by_receiver)`,
      `CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_messages_time ON group_messages(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_email)`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_email)`,
      `CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_email)`,
      `CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_email)`,
      `CREATE INDEX IF NOT EXISTS idx_calls_receiver ON calls(receiver_email)`,
      `CREATE INDEX IF NOT EXISTS idx_agora_calls_caller ON agora_calls(caller_email)`,
      `CREATE INDEX IF NOT EXISTS idx_agora_calls_receiver ON agora_calls(receiver_email)`
    ];

    for (const query of queries) {
      try {
        await client.query(query);
        const tableName = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
        if (tableName) {
          console.log(`✅ Таблица: ${tableName[1]}`);
        }
      } catch (tableError) {
        console.error('❌ Ошибка создания таблицы:', tableError.message);
      }
    }
    
    console.log('✅ Все таблицы созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error);
  } finally {
    client.release();
  }
}

// Функция для инициализации БД
async function initializeDB() {
  console.log('🔄 Инициализация базы данных...');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ Ошибка: DATABASE_URL не установлен в переменных окружения');
    console.log('💡 Добавьте в Render Environment:');
    console.log('DATABASE_URL=postgresql://postgres:Sasha256orlov@aws-0-eu-west-1.pooler.supabase.com:6543/postgres');
    process.exit(1);
  }

  // Проверяем подключение с повторными попытками
  let connected = false;
  let attempts = 0;
  const maxAttempts = 3;

  while (!connected && attempts < maxAttempts) {
    attempts++;
    console.log(`🔄 Попытка подключения ${attempts}/${maxAttempts}...`);
    
    connected = await checkConnection();
    
    if (!connected && attempts < maxAttempts) {
      console.log('⏳ Повторная попытка через 2 секунды...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!connected) {
    console.error('❌ Не удалось подключиться к базе данных после всех попыток');
    console.log('🔍 Проверьте:');
    console.log('1. Правильность строки подключения в Render Environment');
    console.log('2. Что база данных Supabase активна');
    console.log('3. Настройки firewall в Supabase');
    process.exit(1);
  }

  // Создаем таблицы
  await createTables();
}

// Вспомогательные функции для работы с БД
const db = {
  // Выполнить запрос с параметрами
  query: (text, params) => {
    console.log('📊 SQL Query:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
    return pool.query(text, params);
  },
  
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
  getClient: () => pool.connect(),
  
  // Проверить соединение
  checkHealth: async () => {
    try {
      const result = await pool.query('SELECT 1 as health_check');
      return result.rows[0].health_check === 1;
    } catch (error) {
      return false;
    }
  }
};

// Обработка ошибок пула
pool.on('error', (err) => {
  console.error('❌ Неожиданная ошибка пула соединений:', err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка пула соединений...');
  await pool.end();
  console.log('✅ Пул соединений остановлен');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Получен сигнал завершения...');
  await pool.end();
  console.log('✅ Пул соединений остановлен');
  process.exit(0);
});

module.exports = { initializeDB, db, pool };
