const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Инициализация базы данных
const db = new sqlite3.Database('./beresta.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, first_name TEXT, last_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, friend_email TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_email TEXT, receiver_email TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// Настройка почтового транспорта
const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: 'pushkatank2@gmail.com',
        pass: '123456789Orlov'
    }
});

// Регистрация пользователя
app.post('/register', (req, res) => {
    const { email, firstName, lastName } = req.body;
    
    db.run("INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?)", 
        [email, firstName, lastName], 
        function(err) {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true, id: this.lastID });
            }
        }
    );
});

// Получение списка пользователей
app.get('/users', (req, res) => {
    db.all("SELECT email, first_name, last_name FROM users", [], (err, rows) => {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            res.json({ success: true, users: rows });
        }
    });
});

// Добавление друга
app.post('/add-friend', (req, res) => {
    const { userEmail, friendEmail } = req.body;
    
    db.run("INSERT INTO friends (user_email, friend_email) VALUES (?, ?)", 
        [userEmail, friendEmail], 
        function(err) {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true });
            }
        }
    );
});

// Удаление друга
app.post('/remove-friend', (req, res) => {
    const { userEmail, friendEmail } = req.body;
    
    db.run("DELETE FROM friends WHERE user_email = ? AND friend_email = ?", 
        [userEmail, friendEmail], 
        function(err) {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true });
            }
        }
    );
});

// Получение списка друзей
app.get('/friends/:email', (req, res) => {
    const userEmail = req.params.email;
    
    db.all("SELECT f.friend_email, u.first_name, u.last_name FROM friends f JOIN users u ON f.friend_email = u.email WHERE f.user_email = ?", 
        [userEmail], 
        (err, rows) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true, friends: rows });
            }
        }
    );
});

// Отправка сообщения
app.post('/send-message', async (req, res) => {
    const { senderEmail, receiverEmail, message } = req.body;
    
    try {
        // Сохраняем сообщение в БД
        db.run("INSERT INTO messages (sender_email, receiver_email, message) VALUES (?, ?, ?)", 
            [senderEmail, receiverEmail, message], function(err) {
                if (err) {
                    return res.json({ success: false, error: err.message });
                }
            });
        
        // Пытаемся отправить email (не блокируем ответ при ошибках)
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
            
            await transporter.sendMail(mailOptions);
            console.log("Email отправлен успешно");
        } catch (emailError) {
            console.log("Ошибка отправки email:", emailError.message);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.log("Общая ошибка:", error.message);
        res.json({ success: false, error: error.message });
    }
});

// Получение истории сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const { userEmail, friendEmail } = req.params;
    
    db.all("SELECT * FROM messages WHERE (sender_email = ? AND receiver_email = ?) OR (sender_email = ? AND receiver_email = ?) ORDER BY timestamp", 
        [userEmail, friendEmail, friendEmail, userEmail], 
        (err, rows) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true, messages: rows });
            }
        }
    );
});

// Статистика для админ-панели
app.get('/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as total_users FROM users", (err, userCount) => {
        if (err) return res.json({ success: false, error: err.message });
        
        db.get("SELECT COUNT(*) as total_messages FROM messages", (err, messageCount) => {
            if (err) return res.json({ success: false, error: err.message });
            
            db.get("SELECT COUNT(*) as total_friends FROM friends", (err, friendCount) => {
                if (err) return res.json({ success: false, error: err.message });
                
                // Получаем последние 24 часа активности
                db.get(`SELECT COUNT(*) as active_today FROM users 
                       WHERE datetime(created_at) >= datetime('now', '-1 day')`, 
                (err, activeResult) => {
                    res.json({
                        success: true,
                        stats: {
                            total_users: userCount.total_users,
                            total_messages: messageCount.total_messages,
                            total_friends: friendCount.total_friends,
                            active_today: activeResult.active_today,
                            online_users: Math.floor(Math.random() * 50) + 1
                        }
                    });
                });
            });
        });
    });
});

// Список пользователей для админ-панели
app.get('/admin/users', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    db.all(`SELECT id, email, first_name, last_name, 
           datetime(created_at) as created_at 
           FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`, 
    [limit, offset], (err, rows) => {
        if (err) {
            return res.json({ success: false, error: err.message });
        }

        db.get("SELECT COUNT(*) as total FROM users", (err, countResult) => {
            if (err) {
                return res.json({ success: false, error: err.message });
            }

            res.json({
                success: true,
                users: rows,
                pagination: {
                    page: page,
                    limit: limit,
                    total: countResult.total,
                    total_pages: Math.ceil(countResult.total / limit)
                }
            });
        });
    });
});

// Детальная статистика пользователя
app.get('/admin/user/:email', (req, res) => {
    const userEmail = req.params.email;
    
    db.get(`SELECT id, email, first_name, last_name, 
           datetime(created_at) as created_at 
           FROM users WHERE email = ?`, 
    [userEmail], (err, user) => {
        if (err) return res.json({ success: false, error: err.message });
        
        if (!user) {
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        
        // Количество друзей
        db.get(`SELECT COUNT(*) as friend_count FROM friends 
               WHERE user_email = ?`, 
        [userEmail], (err, friendCount) => {
            if (err) return res.json({ success: false, error: err.message });
            
            // Количество сообщений
            db.get(`SELECT COUNT(*) as message_count FROM messages 
                   WHERE sender_email = ? OR receiver_email = ?`, 
            [userEmail, userEmail], (err, messageCount) => {
                if (err) return res.json({ success: false, error: err.message });
                
                res.json({
                    success: true,
                    user: user,
                    stats: {
                        friend_count: friendCount.friend_count,
                        message_count: messageCount.message_count
                    }
                });
            });
        });
    });
});

// Веб-интерфейс администратора
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Береста сервер работает',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint не найден',
        available_endpoints: [
            'POST /register',
            'GET /users', 
            'POST /add-friend',
            'POST /remove-friend',
            'GET /friends/:email',
            'POST /send-message',
            'GET /messages/:userEmail/:friendEmail',
            'GET /admin/stats',
            'GET /admin/users',
            'GET /admin/user/:email',
            'GET /admin',
            'GET /health'
        ]
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Ошибка сервера:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Внутренняя ошибка сервера',
        message: err.message
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Береста сервер запущен на порту ${PORT}`);
    console.log(`📊 Админ-панель: http://localhost:${PORT}/admin`);
    console.log(`📱 API: http://localhost:${PORT}/health`);
    console.log(`👤 Все endpoints: http://localhost:${PORT}/nonexistent`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    db.close((err) => {
        if (err) {
            console.error('Ошибка закрытия БД:', err);
        } else {
            console.log('✅ База данных закрыта');
        }
        process.exit(0);
    });
});

module.exports = app;
