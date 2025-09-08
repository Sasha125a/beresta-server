const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Для статических файлов

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

// API endpoints (оставляем существующие)
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

app.get('/users', (req, res) => {
    db.all("SELECT email, first_name, last_name, created_at FROM users ORDER BY created_at DESC", [], (err, rows) => {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            res.json({ success: true, users: rows });
        }
    });
});

// ... остальные API endpoints ...

// НОВЫЕ endpoints для админ-панели
app.get('/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as total_users FROM users", (err, userCount) => {
        if (err) return res.json({ success: false, error: err.message });
        
        db.get("SELECT COUNT(*) as total_messages FROM messages", (err, messageCount) => {
            if (err) return res.json({ success: false, error: err.message });
            
            db.get("SELECT COUNT(*) as total_friends FROM friends", (err, friendCount) => {
                if (err) return res.json({ success: false, error: err.message });
                
                res.json({
                    success: true,
                    stats: {
                        total_users: userCount.total_users,
                        total_messages: messageCount.total_messages,
                        total_friends: friendCount.total_friends,
                        online_users: Math.floor(Math.random() * 50) + 1 // Mock данные
                    }
                });
            });
        });
    });
});

app.get('/admin/users', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    db.all("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset], (err, rows) => {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            db.get("SELECT COUNT(*) as total FROM users", (err, countResult) => {
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
        }
    });
});

// Веб-интерфейс администратора
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📊 Админ-панель: http://localhost:${PORT}/admin`);
    console.log(`📱 API доступно: http://localhost:${PORT}/users`);
});
