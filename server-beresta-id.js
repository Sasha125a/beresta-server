const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// PostgreSQL подключение для Beresta ID (отдельная база)
const pool = new Pool({
  connectionString: process.env.BERESTA_ID_DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// JWT секрет
const JWT_SECRET = process.env.BERESTA_JWT_SECRET || 'beresta_id_secret_key_2024';

// Функция для создания таблиц Beresta ID
async function createBerestaTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Создание/проверка таблиц Beresta ID...');

    const queries = [
      // Таблица пользователей Beresta ID
      `CREATE TABLE IF NOT EXISTS beresta_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar_url TEXT DEFAULT '',
        is_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        refresh_token TEXT DEFAULT ''
      )`,

      // Таблица сессий
      `CREATE TABLE IF NOT EXISTS beresta_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES beresta_users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        device_info TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      )`,

      // Индексы
      `CREATE INDEX IF NOT EXISTS idx_beresta_users_email ON beresta_users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_beresta_sessions_token ON beresta_sessions(token)`,
      `CREATE INDEX IF NOT EXISTS idx_beresta_sessions_user ON beresta_sessions(user_id)`
    ];

    for (const query of queries) {
      try {
        await client.query(query);
        console.log(`✅ Таблица Beresta ID создана/проверена`);
      } catch (tableError) {
        console.error('❌ Ошибка создания таблицы Beresta ID:', tableError.message);
      }
    }
    
    console.log('✅ Все таблицы Beresta ID созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц Beresta ID:', error);
  } finally {
    client.release();
  }
}

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            success: true, 
            status: 'Beresta ID Server is running',
            timestamp: new Date().toISOString(),
            database: 'PostgreSQL'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Регистрация пользователя Beresta ID
app.post('/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ 
                success: false, 
                error: 'Все поля обязательны' 
            });
        }

        // Проверяем email
        if (!email.includes('@')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Некорректный email' 
            });
        }

        // Проверяем длину пароля
        if (password.length < 6) {
            return res.status(400).json({ 
                success: false, 
                error: 'Пароль должен быть не менее 6 символов' 
            });
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Проверяем существующего пользователя
            const existingUser = await client.query(
                "SELECT id FROM beresta_users WHERE email = $1", 
                [email.toLowerCase()]
            );

            if (existingUser.rows.length > 0) {
                return res.status(409).json({ 
                    success: false, 
                    error: 'Пользователь с таким email уже существует' 
                });
            }

            // Хешируем пароль
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);

            // Создаем пользователя
            const userResult = await client.query(
                `INSERT INTO beresta_users (email, password, name) 
                 VALUES ($1, $2, $3) RETURNING id, email, name, created_at`,
                [email.toLowerCase(), hashedPassword, name]
            );

            const user = userResult.rows[0];

            // Создаем JWT токен
            const token = jwt.sign(
                { 
                    userId: user.id, 
                    email: user.email,
                    type: 'beresta_id'
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Создаем refresh token
            const refreshToken = jwt.sign(
                { 
                    userId: user.id,
                    type: 'refresh'
                },
                JWT_SECRET,
                { expiresIn: '90d' }
            );

            // Сохраняем сессию
            await client.query(
                `INSERT INTO beresta_sessions (user_id, token, expires_at) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
                [user.id, refreshToken]
            );

            await client.query('COMMIT');

            res.json({
                success: true,
                message: 'Регистрация успешна',
                token: token,
                refreshToken: refreshToken,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    createdAt: user.created_at
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('❌ Ошибка регистрации Beresta ID:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Вход пользователя Beresta ID
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email и пароль обязательны' 
            });
        }

        const client = await pool.connect();
        
        try {
            // Ищем пользователя
            const userResult = await client.query(
                `SELECT id, email, password, name, avatar_url FROM beresta_users 
                 WHERE email = $1`,
                [email.toLowerCase()]
            );

            if (userResult.rows.length === 0) {
                return res.status(401).json({ 
                    success: false, 
                    error: 'Неверный email или пароль' 
                });
            }

            const user = userResult.rows[0];

            // Проверяем пароль
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(401).json({ 
                    success: false, 
                    error: 'Неверный email или пароль' 
                });
            }

            // Обновляем время последнего входа
            await client.query(
                "UPDATE beresta_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1",
                [user.id]
            );

            // Создаем JWT токен
            const token = jwt.sign(
                { 
                    userId: user.id, 
                    email: user.email,
                    type: 'beresta_id'
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Создаем refresh token
            const refreshToken = jwt.sign(
                { 
                    userId: user.id,
                    type: 'refresh'
                },
                JWT_SECRET,
                { expiresIn: '90d' }
            );

            // Сохраняем сессию
            await client.query(
                `INSERT INTO beresta_sessions (user_id, token, expires_at) 
                 VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
                [user.id, refreshToken]
            );

            res.json({
                success: true,
                message: 'Вход выполнен',
                token: token,
                refreshToken: refreshToken,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    avatarUrl: user.avatar_url
                }
            });

        } catch (error) {
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('❌ Ошибка входа Beresta ID:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Выход пользователя Beresta ID
app.post('/auth/logout', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ success: false, error: 'Токен обязателен' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Удаляем сессии пользователя
            await pool.query(
                "DELETE FROM beresta_sessions WHERE user_id = $1",
                [decoded.userId]
            );

            res.json({
                success: true,
                message: 'Выход выполнен'
            });

        } catch (jwtError) {
            return res.status(401).json({ success: false, error: 'Неверный токен' });
        }

    } catch (error) {
        console.error('❌ Ошибка выхода Beresta ID:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Проверка токена Beresta ID
app.get('/auth/verify', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ valid: false, error: 'Токен обязателен' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Проверяем что пользователь существует
            const userResult = await pool.query(
                "SELECT id, email, name FROM beresta_users WHERE id = $1",
                [decoded.userId]
            );

            if (userResult.rows.length === 0) {
                return res.json({ valid: false, error: 'Пользователь не найден' });
            }

            res.json({
                valid: true,
                user: {
                    id: userResult.rows[0].id,
                    email: userResult.rows[0].email,
                    name: userResult.rows[0].name
                }
            });

        } catch (jwtError) {
            res.json({ valid: false, error: 'Неверный токен' });
        }

    } catch (error) {
        console.error('❌ Ошибка проверки токена:', error);
        res.status(500).json({ valid: false, error: 'Internal server error' });
    }
});

// Обновление токена
app.post('/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ success: false, error: 'Refresh token обязателен' });
        }

        try {
            const decoded = jwt.verify(refreshToken, JWT_SECRET);
            
            // Проверяем существование сессии
            const sessionResult = await pool.query(
                `SELECT s.id, u.id as user_id, u.email, u.name 
                 FROM beresta_sessions s 
                 JOIN beresta_users u ON s.user_id = u.id 
                 WHERE s.token = $1 AND s.is_active = TRUE AND s.expires_at > NOW()`,
                [refreshToken]
            );

            if (sessionResult.rows.length === 0) {
                return res.status(401).json({ success: false, error: 'Недействительный refresh token' });
            }

            const user = sessionResult.rows[0];

            // Создаем новый access token
            const newToken = jwt.sign(
                { 
                    userId: user.user_id, 
                    email: user.email,
                    type: 'beresta_id'
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            res.json({
                success: true,
                token: newToken,
                user: {
                    id: user.user_id,
                    email: user.email,
                    name: user.name
                }
            });

        } catch (jwtError) {
            return res.status(401).json({ success: false, error: 'Неверный refresh token' });
        }

    } catch (error) {
        console.error('❌ Ошибка обновления токена:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение профиля пользователя Beresta ID
app.get('/api/profile', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ success: false, error: 'Токен обязателен' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            const userResult = await pool.query(
                `SELECT id, email, name, avatar_url, created_at, last_login 
                 FROM beresta_users WHERE id = $1`,
                [decoded.userId]
            );

            if (userResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Пользователь не найден' });
            }

            const user = userResult.rows[0];

            res.json({
                success: true,
                profile: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    avatarUrl: user.avatar_url,
                    createdAt: user.created_at,
                    lastLogin: user.last_login
                }
            });

        } catch (jwtError) {
            return res.status(401).json({ success: false, error: 'Неверный токен' });
        }

    } catch (error) {
        console.error('❌ Ошибка получения профиля:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Обновление профиля пользователя Beresta ID
app.put('/api/profile', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        const { name, avatarUrl } = req.body;

        if (!token) {
            return res.status(401).json({ success: false, error: 'Токен обязателен' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            let query = "UPDATE beresta_users SET ";
            let params = [];
            let setParts = [];

            if (name !== undefined) {
                setParts.push("name = $" + (params.length + 1));
                params.push(name);
            }

            if (avatarUrl !== undefined) {
                setParts.push("avatar_url = $" + (params.length + 1));
                params.push(avatarUrl);
            }

            if (setParts.length === 0) {
                return res.status(400).json({ success: false, error: 'Нет данных для обновления' });
            }

            query += setParts.join(", ") + " WHERE id = $" + (params.length + 1);
            params.push(decoded.userId);

            await pool.query(query, params);

            // Получаем обновленный профиль
            const userResult = await pool.query(
                `SELECT id, email, name, avatar_url, created_at, last_login 
                 FROM beresta_users WHERE id = $1`,
                [decoded.userId]
            );

            res.json({
                success: true,
                message: 'Профиль обновлен',
                profile: {
                    id: userResult.rows[0].id,
                    email: userResult.rows[0].email,
                    name: userResult.rows[0].name,
                    avatarUrl: userResult.rows[0].avatar_url,
                    createdAt: userResult.rows[0].created_at,
                    lastLogin: userResult.rows[0].last_login
                }
            });

        } catch (jwtError) {
            return res.status(401).json({ success: false, error: 'Неверный токен' });
        }

    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Смена пароля Beresta ID
app.post('/auth/change-password', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        const { currentPassword, newPassword } = req.body;

        if (!token) {
            return res.status(401).json({ success: false, error: 'Токен обязателен' });
        }

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Текущий и новый пароль обязательны' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Новый пароль должен быть не менее 6 символов' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Получаем текущий пароль
            const userResult = await pool.query(
                "SELECT password FROM beresta_users WHERE id = $1",
                [decoded.userId]
            );

            if (userResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Пользователь не найден' });
            }

            const currentHashedPassword = userResult.rows[0].password;

            // Проверяем текущий пароль
            const isCurrentPasswordValid = await bcrypt.compare(currentPassword, currentHashedPassword);
            if (!isCurrentPasswordValid) {
                return res.status(401).json({ success: false, error: 'Неверный текущий пароль' });
            }

            // Хешируем новый пароль
            const saltRounds = 10;
            const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);

            // Обновляем пароль
            await pool.query(
                "UPDATE beresta_users SET password = $1 WHERE id = $2",
                [newHashedPassword, decoded.userId]
            );

            res.json({
                success: true,
                message: 'Пароль успешно изменен'
            });

        } catch (jwtError) {
            return res.status(401).json({ success: false, error: 'Неверный токен' });
        }

    } catch (error) {
        console.error('❌ Ошибка смены пароля:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Запуск сервера Beresta ID
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Beresta ID Server запущен на порту ${PORT}`);
    console.log(`🌐 URL: http://0.0.0.0:${PORT}`);
    console.log(`🔧 Режим: ${process.env.NODE_ENV || 'development'}`);
    
    // Создаем таблицы при запуске
    await createBerestaTables();
    
    console.log('✅ Beresta ID Server готов к работе');
});
