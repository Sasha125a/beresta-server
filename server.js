const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(express.static('public'));

// Инициализация базы данных
const dbPath = process.env.DB_PATH || './beresta.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключение к SQLite базе данных установлено');
        console.log('Путь к БД:', dbPath);
    }
});

// Включаем поддержку внешних ключей
db.run("PRAGMA foreign_keys = ON");

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email),
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (friend_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Создаем индексы для оптимизации запросов
    db.run("CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
});

// Настройка почтового транспорта (отключена для тестирования)
let transporter;
try {
    transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER || 'pushkatank2@gmail.com',
            pass: process.env.EMAIL_PASS || '123456789Orlov'
        }
    });
    console.log('📧 Email транспорт настроен');
} catch (error) {
    console.log('⚠️ Email транспорт отключен:', error.message);
    transporter = null;
}

// Вспомогательная функция для обработки ошибок БД
function handleDatabaseError(err, res) {
    console.error('Ошибка БД:', err.message);
    res.status(500).json({ 
        success: false, 
        error: 'Ошибка базы данных',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
}

// Проверка подключения к БД
app.get('/health', (req, res) => {
    db.get("SELECT 1 as test", [], (err) => {
        if (err) {
            res.status(500).json({ 
                success: false, 
                status: 'Database connection failed',
                error: err.message 
            });
        } else {
            res.json({ 
                success: true, 
                status: 'Server is running',
                timestamp: new Date().toISOString(),
                database: 'Connected',
                email: transporter ? 'Configured' : 'Disabled'
            });
        }
    });
});

// Регистрация пользователя
app.post('/register', (req, res) => {
    const { email, firstName, lastName } = req.body;
    
    if (!email || !firstName || !lastName) {
        return res.status(400).json({ 
            success: false, 
            error: 'Все поля обязательны для заполнения' 
        });
    }

    if (!email.includes('@')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Некорректный email' 
        });
    }

    db.run(
        "INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?)", 
        [email.toLowerCase(), firstName.trim(), lastName.trim()], 
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    res.status(409).json({ 
                        success: false, 
                        error: 'Пользователь с таким email уже существует' 
                    });
                } else {
                    handleDatabaseError(err, res);
                }
            } else {
                res.json({ 
                    success: true, 
                    id: this.lastID,
                    message: 'Пользователь успешно зарегистрирован' 
                });
            }
        }
    );
});

// Получение списка всех пользователей
app.get('/users', (req, res) => {
    db.all("SELECT email, first_name, last_name FROM users ORDER BY first_name, last_name", [], (err, rows) => {
        if (err) {
            handleDatabaseError(err, res);
        } else {
            res.json({ 
                success: true, 
                users: rows,
                count: rows.length 
            });
        }
    });
});

// Добавление друга
app.post('/add-friend', (req, res) => {
    const { userEmail, friendEmail } = req.body;
    
    if (!userEmail || !friendEmail) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email пользователя и друга обязательны' 
        });
    }

    if (userEmail.toLowerCase() === friendEmail.toLowerCase()) {
        return res.status(400).json({ 
            success: false, 
            error: 'Нельзя добавить самого себя в друзья' 
        });
    }

    // Проверяем, существует ли пользователь
    db.get("SELECT email FROM users WHERE email = ?", [friendEmail.toLowerCase()], (err, row) => {
        if (err) {
            return handleDatabaseError(err, res);
        }

        if (!row) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователь с таким email не найден' 
            });
        }

        // Добавляем друга
        db.run(
            "INSERT INTO friends (user_email, friend_email) VALUES (?, ?)", 
            [userEmail.toLowerCase(), friendEmail.toLowerCase()], 
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        res.status(409).json({ 
                            success: false, 
                            error: 'Этот пользователь уже у вас в друзьях' 
                        });
                    } else {
                        handleDatabaseError(err, res);
                    }
                } else {
                    res.json({ 
                        success: true, 
                        message: 'Друг успешно добавлен' 
                    });
                }
            }
        );
    });
});

// Удаление друга
app.post('/remove-friend', (req, res) => {
    const { userEmail, friendEmail } = req.body;
    
    if (!userEmail || !friendEmail) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email пользователя и друга обязательны' 
        });
    }

    db.run(
        "DELETE FROM friends WHERE user_email = ? AND friend_email = ?", 
        [userEmail.toLowerCase(), friendEmail.toLowerCase()], 
        function(err) {
            if (err) {
                handleDatabaseError(err, res);
            } else if (this.changes === 0) {
                res.status(404).json({ 
                    success: false, 
                    error: 'Друг не найден' 
                });
            } else {
                res.json({ 
                    success: true, 
                    message: 'Друг успешно удален' 
                });
            }
        }
    );
});

// Получение списка друзей пользователя
app.get('/friends/:email', (req, res) => {
    const userEmail = req.params.email.toLowerCase();
    
    db.all(
        `SELECT f.friend_email, u.first_name, u.last_name 
         FROM friends f 
         JOIN users u ON f.friend_email = u.email 
         WHERE f.user_email = ? 
         ORDER BY u.first_name, u.last_name`, 
        [userEmail], 
        (err, rows) => {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    friends: rows,
                    count: rows.length 
                });
            }
        }
    );
});

// Отправка сообщения
app.post('/send-message', (req, res) => {
    const { senderEmail, receiverEmail, message } = req.body;
    
    if (!senderEmail || !receiverEmail || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Все поля обязательны для заполнения' 
        });
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
        return res.status(400).json({ 
            success: false, 
            error: 'Сообщение не может быть пустым' 
        });
    }

    if (trimmedMessage.length > 1000) {
        return res.status(400).json({ 
            success: false, 
            error: 'Сообщение слишком длинное (максимум 1000 символов)' 
        });
    }

    // Сохраняем сообщение в БД
    db.run(
        "INSERT INTO messages (sender_email, receiver_email, message) VALUES (?, ?, ?)", 
        [senderEmail.toLowerCase(), receiverEmail.toLowerCase(), trimmedMessage], 
        function(err) {
            if (err) {
                return handleDatabaseError(err, res);
            }

            // Пытаемся отправить email (не блокируем основной поток)
            if (transporter) {
                try {
                    const mailOptions = {
                        from: process.env.EMAIL_USER || 'pushkatank2@gmail.com',
                        to: receiverEmail,
                        subject: `💌 Новое сообщение в Бересте от ${senderEmail}`,
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                <h2 style="color: #2c3e50;">Береста - Новое сообщение</h2>
                                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #3498db;">
                                    <p style="margin: 0; color: #2c3e50; font-size: 16px;">
                                        <strong>От:</strong> ${senderEmail}<br>
                                        <strong>Сообщение:</strong> ${trimmedMessage}
                                    </p>
                                </div>
                                <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                                    Ответьте на это письмо, чтобы отправить ответ в мессенджер Береста.
                                </p>
                            </div>
                        `
                    };
                    
                    transporter.sendMail(mailOptions, (emailError, info) => {
                        if (emailError) {
                            console.log('Ошибка отправки email:', emailError.message);
                        } else {
                            console.log('Email отправлен:', info.messageId);
                        }
                    });
                } catch (emailError) {
                    console.log('Ошибка при подготовке email:', emailError.message);
                }
            }

            res.json({ 
                success: true, 
                message: 'Сообщение отправлено',
                messageId: this.lastID,
                timestamp: new Date().toISOString()
            });
        }
    );
});

// Получение истории сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const userEmail = req.params.userEmail.toLowerCase();
    const friendEmail = req.params.friendEmail.toLowerCase();
    
    db.all(
        `SELECT sender_email, receiver_email, message, 
                datetime(timestamp, 'localtime') as timestamp 
         FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?) 
         ORDER BY timestamp ASC`, 
        [userEmail, friendEmail, friendEmail, userEmail], 
        (err, rows) => {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    messages: rows,
                    count: rows.length 
                });
            }
        }
    );
});

// Очистка истории чата
app.post('/clear-chat', (req, res) => {
    const { userEmail, friendEmail } = req.body;
    
    if (!userEmail || !friendEmail) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email пользователя и друга обязательны' 
        });
    }

    db.run(
        `DELETE FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?)`, 
        [userEmail.toLowerCase(), friendEmail.toLowerCase(), 
         friendEmail.toLowerCase(), userEmail.toLowerCase()], 
        function(err) {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    message: 'История чата очищена',
                    deletedCount: this.changes
                });
            }
        }
    );
});

// Получение информации о пользователе
app.get('/user/:email', (req, res) => {
    const email = req.params.email.toLowerCase();
    
    db.get(
        "SELECT email, first_name, last_name FROM users WHERE email = ?", 
        [email], 
        (err, row) => {
            if (err) {
                handleDatabaseError(err, res);
            } else if (!row) {
                res.status(404).json({ 
                    success: false, 
                    error: 'Пользователь не найден' 
                });
            } else {
                res.json({ 
                    success: true, 
                    user: row 
                });
            }
        }
    );
});

// Получение последних сообщений пользователя
app.get('/recent-chats/:email', (req, res) => {
    const userEmail = req.params.email.toLowerCase();
    
    db.all(
        `SELECT DISTINCT 
            CASE 
                WHEN sender_email = ? THEN receiver_email 
                ELSE sender_email 
            END as contact_email,
            u.first_name,
            u.last_name,
            MAX(m.timestamp) as last_message_time
         FROM messages m
         JOIN users u ON u.email = CASE 
                WHEN m.sender_email = ? THEN m.receiver_email 
                ELSE m.sender_email 
            END
         WHERE sender_email = ? OR receiver_email = ?
         GROUP BY contact_email
         ORDER BY last_message_time DESC
         LIMIT 20`,
        [userEmail, userEmail, userEmail, userEmail],
        (err, rows) => {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    recentChats: rows,
                    count: rows.length 
                });
            }
        }
    );
});

// Статистика сервера
app.get('/stats', (req, res) => {
    db.all(
        `SELECT 
            (SELECT COUNT(*) FROM users) as users_count,
            (SELECT COUNT(*) FROM friends) as friendships_count,
            (SELECT COUNT(*) FROM messages) as messages_count,
            (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as messages_today`,
        [],
        (err, rows) => {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    stats: rows[0] 
                });
            }
        }
    );
});

// Обработка несуществующих routes
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint не найден',
        availableEndpoints: [
            'POST /register',
            'GET /users',
            'POST /add-friend',
            'POST /remove-friend',
            'GET /friends/:email',
            'POST /send-message',
            'GET /messages/:userEmail/:friendEmail',
            'POST /clear-chat',
            'GET /user/:email',
            'GET /recent-chats/:email',
            'GET /stats',
            'GET /health'
        ]
    });
});

// Обработка ошибок
app.use((error, req, res, next) => {
    console.error('Необработанная ошибка:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Внутренняя ошибка сервера',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер Береста запущен на порту ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📧 Режим email: ${transporter ? 'Настроен' : 'Отключен'}`);
    console.log(`🗄️  База данных: ${dbPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    db.close((err) => {
        if (err) {
            console.error('Ошибка закрытия БД:', err.message);
        } else {
            console.log('✅ Подключение к БД закрыто');
        }
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Получен сигнал SIGTERM...');
    db.close((err) => {
        if (err) {
            console.error('Ошибка закрытия БД:', err.message);
        } else {
            console.log('✅ Подключение к БД закрыто');
        }
        process.exit(0);
    });
});
