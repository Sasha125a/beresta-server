const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Инициализация базы данных
const db = new sqlite3.Database('./beresta.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключение к SQLite базе данных установлено');
    }
});

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
        FOREIGN KEY (user_email) REFERENCES users (email),
        FOREIGN KEY (friend_email) REFERENCES users (email)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_email) REFERENCES users (email),
        FOREIGN KEY (receiver_email) REFERENCES users (email)
    )`);

    // Создаем индексы для оптимизации запросов
    db.run("CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)");
});

// Настройка почтового транспорта (отключена для тестирования)
const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: 'pushkatank2@gmail.com',
        pass: '123456789Orlov'
    }
});

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
                timestamp: new Date().toISOString()
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

    db.run(
        "INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?)", 
        [email, firstName, lastName], 
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    res.status(409).json({ 
                        success: false, 
                        error: 'Пользователь с таким email уже существует' 
                    });
                } else {
                    res.status(500).json({ 
                        success: false, 
                        error: err.message 
                    });
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
            res.status(500).json({ 
                success: false, 
                error: err.message 
            });
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

    if (userEmail === friendEmail) {
        return res.status(400).json({ 
            success: false, 
            error: 'Нельзя добавить самого себя в друзья' 
        });
    }

    // Проверяем, существует ли пользователь
    db.get("SELECT email FROM users WHERE email = ?", [friendEmail], (err, row) => {
        if (err) {
            return res.status(500).json({ 
                success: false, 
                error: err.message 
            });
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
            [userEmail, friendEmail], 
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        res.status(409).json({ 
                            success: false, 
                            error: 'Этот пользователь уже у вас в друзьях' 
                        });
                    } else {
                        res.status(500).json({ 
                            success: false, 
                            error: err.message 
                        });
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
        [userEmail, friendEmail], 
        function(err) {
            if (err) {
                res.status(500).json({ 
                    success: false, 
                    error: err.message 
                });
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
    const userEmail = req.params.email;
    
    db.all(
        `SELECT f.friend_email, u.first_name, u.last_name 
         FROM friends f 
         JOIN users u ON f.friend_email = u.email 
         WHERE f.user_email = ? 
         ORDER BY u.first_name, u.last_name`, 
        [userEmail], 
        (err, rows) => {
            if (err) {
                res.status(500).json({ 
                    success: false, 
                    error: err.message 
                });
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
app.post('/send-message', async (req, res) => {
    const { senderEmail, receiverEmail, message } = req.body;
    
    if (!senderEmail || !receiverEmail || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Все поля обязательны для заполнения' 
        });
    }

    if (message.trim().length === 0) {
        return res.status(400).json({ 
            success: false, 
            error: 'Сообщение не может быть пустым' 
        });
    }

    try {
        // Сохраняем сообщение в БД
        db.run(
            "INSERT INTO messages (sender_email, receiver_email, message) VALUES (?, ?, ?)", 
            [senderEmail, receiverEmail, message.trim()], 
            function(err) {
                if (err) {
                    return res.status(500).json({ 
                        success: false, 
                        error: err.message 
                    });
                }

                // Пытаемся отправить email (не блокируем основной поток)
                try {
                    const mailOptions = {
                        from: 'pushkatank2@gmail.com',
                        to: receiverEmail,
                        subject: `💌 Новое сообщение в Бересте от ${senderEmail}`,
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                <h2 style="color: #2c3e50;">Береста - Новое сообщение</h2>
                                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #3498db;">
                                    <p style="margin: 0; color: #2c3e50; font-size: 16px;">
                                        <strong>От:</strong> ${senderEmail}<br>
                                        <strong>Сообщение:</strong> ${message}
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

                res.json({ 
                    success: true, 
                    message: 'Сообщение отправлено',
                    messageId: this.lastID 
                });
            }
        );
    } catch (error) {
        console.log('Общая ошибка:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Внутренняя ошибка сервера' 
        });
    }
});

// Получение истории сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const { userEmail, friendEmail } = req.params;
    
    db.all(
        `SELECT id, sender_email, receiver_email, message, timestamp 
         FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?) 
         ORDER BY timestamp ASC`, 
        [userEmail, friendEmail, friendEmail, userEmail], 
        (err, rows) => {
            if (err) {
                res.status(500).json({ 
                    success: false, 
                    error: err.message 
                });
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

// Получение информации о пользователе
app.get('/user/:email', (req, res) => {
    const email = req.params.email;
    
    db.get(
        "SELECT email, first_name, last_name FROM users WHERE email = ?", 
        [email], 
        (err, row) => {
            if (err) {
                res.status(500).json({ 
                    success: false, 
                    error: err.message 
                });
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
            'GET /health',
            'GET /user/:email'
        ]
    });
});

// Обработка ошибок
app.use((error, req, res, next) => {
    console.error('Необработанная ошибка:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Внутренняя ошибка сервера' 
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер Береста запущен на порту ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📧 Режим email: ${transporter ? 'Настроен' : 'Отключен'}`);
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
