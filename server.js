const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Инициализация базы данных
const db = new sqlite3.Database(process.env.DB_PATH || './beresta.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, first_name TEXT, last_name TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, friend_email TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_email TEXT, receiver_email TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// Настройка почтового транспорта (замените на свои данные)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'pushkatank2@gmail.com', // ваша почта
        pass: '123456789Orlov'     // пароль приложения
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
        
        // Пытаемся отправить email, но не блокируем ответ из-за ошибок email
        try {
            const mailOptions = {
                from: 'pushkatank2@gmail.com', // ✅ Правильный email
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
            // Не прерываем выполнение, только логируем ошибку
        }
        
        res.json({ success: true }); // ✅ Всегда возвращаем успех, т.к. сообщение сохранено
        
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

// Важно: слушать на 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Available at: http://0.0.0.0:${PORT}`);
});
