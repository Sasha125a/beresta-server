const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));

// Настройка загрузки файлов
const uploadDir = process.env.UPLOAD_DIR || '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('📁 Создана папка для загрузок:', uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        cb(null, 'file_' + uniqueSuffix + extension);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024,
        fieldSize: 50 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

// Инициализация базы данных
const dbPath = process.env.DB_PATH || '/tmp/beresta.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
    } else {
        console.log('✅ Подключение к SQLite базе данных установлено');
    }
});

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
        message TEXT DEFAULT '',
        attachment_type TEXT DEFAULT '',
        attachment_filename TEXT DEFAULT '',
        attachment_original_name TEXT DEFAULT '',
        attachment_mime_type TEXT DEFAULT '',
        attachment_size INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        thumbnail TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent',
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Индексы
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
});

// Функция для определения типа файла
function getFileType(mimetype, filename) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype === 'application/pdf') return 'document';
    if (mimetype.includes('word') || mimetype.includes('excel') || mimetype.includes('powerpoint') || 
        mimetype.includes('document') || mimetype.includes('presentation') || mimetype.includes('sheet')) {
        return 'document';
    }
    if (mimetype.includes('zip') || mimetype.includes('rar') || mimetype.includes('tar') || 
        mimetype.includes('7z') || mimetype.includes('compressed')) {
        return 'archive';
    }
    return 'file';
}

// Health check
app.get('/health', (req, res) => {
    db.get("SELECT 1 as test", [], (err) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ 
            success: true, 
            status: 'Server is running',
            timestamp: new Date().toISOString(),
            maxFileSize: '100MB'
        });
    });
});

// Регистрация пользователя
app.post('/register', (req, res) => {
    try {
        const { email, firstName, lastName } = req.body;

        if (!email || !firstName || !lastName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Все поля обязательны: email, firstName, lastName' 
            });
        }

        // Проверяем, существует ли пользователь
        db.get("SELECT id FROM users WHERE email = ?", [email.toLowerCase()], (err, row) => {
            if (err) {
                console.error('❌ Ошибка БД при проверке пользователя:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (row) {
                return res.status(409).json({ 
                    success: false, 
                    error: 'Пользователь с таким email уже существует' 
                });
            }

            // Создаем нового пользователя
            db.run(
                "INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?)",
                [email.toLowerCase(), firstName, lastName],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка БД при регистрации:', err);
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    res.json({
                        success: true,
                        message: 'Пользователь успешно зарегистрирован',
                        userId: this.lastID
                    });
                }
            );
        });
    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение списка пользователей
app.get('/users', (req, res) => {
    try {
        db.all("SELECT email, first_name as firstName, last_name as lastName FROM users ORDER BY first_name, last_name", 
        [], 
        (err, rows) => {
            if (err) {
                console.error('❌ Ошибка БД при получении пользователей:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                users: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователей:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление в друзья
app.post('/add-friend', (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        // Проверяем, существуют ли оба пользователя
        db.get("SELECT COUNT(*) as count FROM users WHERE email IN (?, ?)", 
        [userEmail.toLowerCase(), friendEmail.toLowerCase()], 
        (err, row) => {
            if (err) {
                console.error('❌ Ошибка БД:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (row.count !== 2) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Один или оба пользователя не найдены' 
                });
            }

            // Добавляем в друзья
            db.run(
                "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)",
                [userEmail.toLowerCase(), friendEmail.toLowerCase()],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка БД:', err);
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    res.json({
                        success: true,
                        message: 'Друг добавлен',
                        changes: this.changes
                    });
                }
            );
        });
    } catch (error) {
        console.error('❌ Ошибка добавления друга:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление из друзей
app.post('/remove-friend', (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        db.run(
            "DELETE FROM friends WHERE user_email = ? AND friend_email = ?",
            [userEmail.toLowerCase(), friendEmail.toLowerCase()],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Друг удален',
                    changes: this.changes
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка удаления друга:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение чатов пользователя
app.get('/chats/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.all(`
            SELECT 
                u.email as contactEmail,
                u.first_name as firstName,
                u.last_name as lastName,
                'friend' as type,
                MAX(m.timestamp) as lastMessageTime
            FROM friends f
            JOIN users u ON u.email = f.friend_email
            LEFT JOIN messages m ON 
                (m.sender_email = f.user_email AND m.receiver_email = f.friend_email) OR
                (m.sender_email = f.friend_email AND m.receiver_email = f.user_email)
            WHERE f.user_email = ?
            GROUP BY u.email, u.first_name, u.last_name
            ORDER BY lastMessageTime DESC, u.first_name, u.last_name
        `, [userEmail], (err, rows) => {
            if (err) {
                console.error('❌ Ошибка БД:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                chats: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения чатов:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление аккаунта
app.delete('/delete-account/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.run(
            "DELETE FROM users WHERE email = ?",
            [userEmail],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Аккаунт удален',
                    changes: this.changes
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Очистка истории чата
app.post('/clear-chat', (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        db.run(
            `DELETE FROM messages 
             WHERE (sender_email = ? AND receiver_email = ?) 
                OR (sender_email = ? AND receiver_email = ?)`,
            [userEmail.toLowerCase(), friendEmail.toLowerCase(), 
             friendEmail.toLowerCase(), userEmail.toLowerCase()],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'История чата очищена',
                    changes: this.changes
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка очистки чата:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла
app.post('/upload-file', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);

        res.json({
            success: true,
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                type: fileType,
                mimeType: req.file.mimetype,
                size: req.file.size,
                url: `/uploads/${req.file.filename}`
            }
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
    }
});

// Отправка сообщения
app.post('/send-message', upload.single('attachment'), (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, duration, thumbnail } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        let attachmentData = null;
        if (req.file) {
            const fileType = getFileType(req.file.mimetype, req.file.originalname);
            attachmentData = {
                filename: req.file.filename,
                originalName: req.file.originalname,
                type: fileType,
                mimeType: req.file.mimetype,
                size: req.file.size,
                duration: duration || 0,
                thumbnail: thumbnail || ''
            };
        }

        db.run(
            `INSERT INTO messages 
             (sender_email, receiver_email, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_mime_type, 
              attachment_size, duration, thumbnail, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [
                senderEmail.toLowerCase(),
                receiverEmail.toLowerCase(),
                message || '',
                attachmentData?.type || '',
                attachmentData?.filename || '',
                attachmentData?.originalName || '',
                attachmentData?.mimeType || '',
                attachmentData?.size || 0,
                attachmentData?.duration || 0,
                attachmentData?.thumbnail || '',
                'sent'
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    if (req.file && fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                    }
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Сообщение отправлено',
                    messageId: this.lastID,
                    timestamp: new Date().toISOString(),
                    attachment: attachmentData
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const userEmail = req.params.userEmail.toLowerCase();
    const friendEmail = req.params.friendEmail.toLowerCase();
    
    db.all(
        `SELECT id, sender_email, receiver_email, message, 
                attachment_type, attachment_filename, attachment_original_name,
                attachment_mime_type, attachment_size, duration, thumbnail,
                datetime(timestamp, 'localtime') as timestamp, status
         FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?) 
         ORDER BY timestamp ASC`,
        [userEmail, friendEmail, friendEmail, userEmail],
        (err, rows) => {
            if (err) {
                console.error('❌ Ошибка БД:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            const messages = rows.map(row => ({
                id: row.id,
                senderEmail: row.sender_email,
                receiverEmail: row.receiver_email,
                message: row.message,
                timestamp: row.timestamp,
                attachmentType: row.attachment_type,
                attachmentUrl: row.attachment_filename ? `/uploads/${row.attachment_filename}` : '',
                attachmentName: row.attachment_original_name,
                attachmentMimeType: row.attachment_mime_type,
                attachmentSize: row.attachment_size,
                duration: row.duration,
                thumbnail: row.thumbnail,
                status: row.status
            }));

            res.json({ success: true, messages });
        }
    );
});

// Получение информации о файле
app.get('/file-info/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    const stats = fs.statSync(filePath);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';
    const fileType = getFileType(mimeType, filename);

    res.json({
        success: true,
        file: {
            filename,
            originalName: filename,
            type: fileType,
            mimeType,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
        }
    });
});

// Скачивание файла
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    const originalName = req.query.originalname || filename;
    res.download(filePath, originalName);
});

// Обновление статуса сообщения
app.post('/update-message-status', (req, res) => {
    const { messageId, status } = req.body;
    
    if (!messageId || !status) {
        return res.status(400).json({ success: false, error: 'Message ID and status required' });
    }

    db.run(
        "UPDATE messages SET status = ? WHERE id = ?",
        [status, messageId],
        function(err) {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }
            res.json({ success: true, updated: this.changes });
        }
    );
});

// Статические файлы
app.use('/uploads', express.static(uploadDir, {
    setHeaders: (res, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = mime.lookup(ext) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        
        if (['.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg'].includes(ext)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
        }
    }
}));

// Обработка ошибок
app.use((error, req, res, next) => {
    console.error('❌ Необработанная ошибка:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Внутренняя ошибка сервера',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер Береста запущен на порту ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log(`📊 База данных: ${dbPath}`);
    console.log(`📦 Поддержка файлов: все форматы до 100MB`);
    console.log('\n📋 Доступные endpointы:');
    console.log('  POST   /register - Регистрация пользователя');
    console.log('  GET    /users - Получение списка пользователей');
    console.log('  POST   /add-friend - Добавление в друзья');
    console.log('  POST   /remove-friend - Удаление из друзей');
    console.log('  GET    /chats/:email - Получение чатов пользователя');
    console.log('  DELETE /delete-account/:email - Удаление аккаунта');
    console.log('  POST   /clear-chat - Очистка истории чата');
    console.log('  POST   /upload-file - Загрузка файла');
    console.log('  POST   /send-message - Отправка сообщения');
    console.log('  GET    /messages/:user/:friend - Получение сообщений');
    console.log('  GET    /file-info/:filename - Информация о файле');
    console.log('  GET    /download/:filename - Скачивание файла');
    console.log('  POST   /update-message-status - Обновление статуса сообщения');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    db.close((err) => {
        if (err) {
            console.error('❌ Ошибка закрытия БД:', err.message);
        } else {
            console.log('✅ Подключение к БД закрыто');
        }
        process.exit(0);
    });
});
