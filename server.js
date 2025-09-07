const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// Инициализация базы данных
const db = new sqlite3.Database('./beresta.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, first_name TEXT, last_name TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, friend_email TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_email TEXT, receiver_email TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// Настройка почтового транспорта (замените на свои данные)
const transporter = nodemailer.createTransporter({
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
            [senderEmail, receiverEmail, message]);
        
        // Отправляем email
        const mailOptions = {
            from: 'your-email@gmail.com',
            to: receiverEmail,
            subject: `Новое сообщение в Бересте от ${senderEmail}`,
            text: `Сообщение: ${message}\n\nОтветьте на это письмо, чтобы отправить ответ в Бересту.`
        };
        
        await transporter.sendMail(mailOptions);
        res.json({ success: true });
    } catch (error) {
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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});