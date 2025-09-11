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
const tempDir = path.join(uploadDir, 'temp');
const permanentDir = path.join(uploadDir, 'permanent');

// Создаем необходимые директории
[uploadDir, tempDir, permanentDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 Создана папка:', dir);
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, tempDir);
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
        downloaded_by_sender BOOLEAN DEFAULT 0,
        downloaded_by_receiver BOOLEAN DEFAULT 0,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Индексы
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_downloads ON messages(downloaded_by_sender, downloaded_by_receiver)");
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

// Функция перемещения файла
function moveFileToPermanent(filename) {
    const tempPath = path.join(tempDir, filename);
    const permanentPath = path.join(permanentDir, filename);
    
    if (fs.existsSync(tempPath)) {
        fs.renameSync(tempPath, permanentPath);
        return true;
    }
    return false;
}

// Функция удаления файла если оба пользователя скачали
function checkAndDeleteFile(messageId, filename) {
    db.get(`SELECT downloaded_by_sender, downloaded_by_receiver FROM messages WHERE id = ?`, 
    [messageId], (err, row) => {
        if (err) {
            console.error('❌ Ошибка проверки статуса скачивания:', err);
            return;
        }

        if (row && row.downloaded_by_sender && row.downloaded_by_receiver) {
            const filePath = path.join(permanentDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️  Файл удален: ${filename}`);
            }
        }
    });
}

// Функция обновления статуса скачивания
function updateDownloadStatus(messageId, userEmail, isSender) {
    const field = isSender ? 'downloaded_by_sender' : 'downloaded_by_receiver';
    
    db.run(`UPDATE messages SET ${field} = 1 WHERE id = ?`, [messageId], function(err) {
        if (err) {
            console.error('❌ Ошибка обновления статуса скачивания:', err);
            return;
        }
        
        db.get(`SELECT attachment_filename FROM messages WHERE id = ?`, [messageId], (err, row) => {
            if (!err && row && row.attachment_filename) {
                checkAndDeleteFile(messageId, row.attachment_filename);
            }
        });
    });
}

// Функция автоматического добавления в чаты
function addToChatsAutomatically(user1, user2, callback) {
    db.get("SELECT COUNT(*) as count FROM users WHERE email IN (?, ?)", 
    [user1.toLowerCase(), user2.toLowerCase()], 
    (err, row) => {
        if (err) {
            console.error('❌ Ошибка проверки пользователей:', err);
            return callback();
        }

        if (row.count !== 2) {
            console.log('⚠️  Один или оба пользователя не найдены');
            return callback();
        }

        const queries = [
            "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)",
            "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)"
        ];

        const values = [
            [user1.toLowerCase(), user2.toLowerCase()],
            [user2.toLowerCase(), user1.toLowerCase()]
        ];

        let completed = 0;
        const total = queries.length;

        function checkCompletion() {
            completed++;
            if (completed === total) {
                console.log(`✅ Автоматически добавлены чаты: ${user1} ↔️ ${user2}`);
                callback();
            }
        }

        queries.forEach((query, index) => {
            db.run(query, values[index], function(err) {
                if (err) {
                    console.error('❌ Ошибка автоматического добавления в чаты:', err);
                }
                checkCompletion();
            });
        });
    });
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
            timestamp: new Date().toISOString()
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
                error: 'Все поля обязательны' 
            });
        }

        db.get("SELECT id FROM users WHERE email = ?", [email.toLowerCase()], (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (row) {
                return res.status(409).json({ 
                    success: false, 
                    error: 'Пользователь уже существует' 
                });
            }

            db.run(
                "INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?)",
                [email.toLowerCase(), firstName, lastName],
                function(err) {
                    if (err) {
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

        db.get("SELECT COUNT(*) as count FROM users WHERE email IN (?, ?)", 
        [userEmail.toLowerCase(), friendEmail.toLowerCase()], 
        (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (row.count !== 2) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Пользователи не найдены' 
                });
            }

            db.run(
                "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)",
                [userEmail.toLowerCase(), friendEmail.toLowerCase()],
                function(err) {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    res.json({
                        success: true,
                        message: 'Друг добавлен'
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
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Друг удален'
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
            
            UNION
            
            SELECT 
                CASE 
                    WHEN m.sender_email = ? THEN m.receiver_email
                    ELSE m.sender_email
                END as contactEmail,
                u.first_name as firstName,
                u.last_name as lastName,
                'chat' as type,
                MAX(m.timestamp) as lastMessageTime
            FROM messages m
            JOIN users u ON u.email = CASE 
                WHEN m.sender_email = ? THEN m.receiver_email
                ELSE m.sender_email
            END
            WHERE (m.sender_email = ? OR m.receiver_email = ?)
            AND NOT EXISTS (
                SELECT 1 FROM friends f 
                WHERE f.user_email = ? 
                AND f.friend_email = CASE 
                    WHEN m.sender_email = ? THEN m.receiver_email
                    ELSE m.sender_email
                END
            )
            GROUP BY contactEmail, u.first_name, u.last_name
            
            ORDER BY lastMessageTime DESC, firstName, lastName
        `, [userEmail, userEmail, userEmail, userEmail, userEmail, userEmail, userEmail], 
        (err, rows) => {
            if (err) {
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

// Получение сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const userEmail = req.params.userEmail.toLowerCase();
    const friendEmail = req.params.friendEmail.toLowerCase();
    
    db.all(
        `SELECT id, sender_email, receiver_email, message, 
                attachment_type, attachment_filename, attachment_original_name,
                attachment_mime_type, attachment_size, duration, thumbnail,
                datetime(timestamp, 'localtime') as timestamp, status,
                downloaded_by_sender, downloaded_by_receiver
         FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?) 
         ORDER BY timestamp ASC`,
        [userEmail, friendEmail, friendEmail, userEmail],
        (err, rows) => {
            if (err) {
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
                status: row.status,
                downloadedBySender: !!row.downloaded_by_sender,
                downloadedByReceiver: !!row.downloaded_by_receiver
            }));

            res.json({ success: true, messages });
        }
    );
});

// Отправка сообщения
app.post('/send-message', upload.single('attachment'), (req, res) => {
    try {
        const { senderEmail, receiverEmail, message } = req.body;

        if (!senderEmail || !receiverEmail) {
            if (req.file) fs.unlinkSync(req.file.path);
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
                duration: 0
            };
        }

        db.run(
            `INSERT INTO messages 
             (sender_email, receiver_email, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_mime_type, 
              attachment_size, duration, status, downloaded_by_sender) 
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
                'sent',
                1
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    if (req.file) fs.unlinkSync(req.file.path);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                // Перемещаем файл в постоянную папку
                if (attachmentData && attachmentData.filename) {
                    if (moveFileToPermanent(attachmentData.filename)) {
                        console.log(`📦 Файл перемещен: ${attachmentData.filename}`);
                    }
                }

                addToChatsAutomatically(senderEmail, receiverEmail, () => {
                    res.json({
                        success: true,
                        message: 'Сообщение отправлено',
                        messageId: this.lastID,
                        timestamp: new Date().toISOString(),
                        attachment: attachmentData
                    });
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Скачивание файла
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const messageId = req.query.messageId;
    const userEmail = req.query.userEmail;
    const filePath = path.join(permanentDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    if (messageId && userEmail) {
        db.get(`SELECT sender_email, receiver_email FROM messages WHERE id = ? AND attachment_filename = ?`, 
        [messageId, filename], (err, row) => {
            if (!err && row) {
                const isSender = row.sender_email.toLowerCase() === userEmail.toLowerCase();
                const isReceiver = row.receiver_email.toLowerCase() === userEmail.toLowerCase();
                
                if (isSender || isReceiver) {
                    updateDownloadStatus(messageId, userEmail, isSender);
                }
            }
        });
    }

    const originalName = req.query.originalname || filename;
    res.download(filePath, originalName);
});

// Удаление аккаунта
app.delete('/delete-account/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.serialize(() => {
            // Удаляем все связанные данные пользователя
            db.run("DELETE FROM friends WHERE user_email = ? OR friend_email = ?", [userEmail, userEmail]);
            db.run("DELETE FROM messages WHERE sender_email = ? OR receiver_email = ?", [userEmail, userEmail]);
            db.run("DELETE FROM users WHERE email = ?", [userEmail], function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ success: false, error: 'Пользователь не найден' });
                }

                res.json({
                    success: true,
                    message: 'Аккаунт успешно удален'
                });
            });
        });
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
            [userEmail.toLowerCase(), friendEmail.toLowerCase(), friendEmail.toLowerCase(), userEmail.toLowerCase()],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'История чата очищена',
                    deletedCount: this.changes
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка очистки чата:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Обновление статуса сообщения
app.post('/update-message-status', (req, res) => {
    try {
        const { messageId, status } = req.body;

        if (!messageId || !status) {
            return res.status(400).json({ success: false, error: 'ID сообщения и статус обязательны' });
        }

        db.run(
            "UPDATE messages SET status = ? WHERE id = ?",
            [status, messageId],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Статус сообщения обновлен',
                    updatedCount: this.changes
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка обновления статуса:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о файле
app.get('/file-info/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(permanentDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        const stats = fs.statSync(filePath);
        const mimeType = mime.lookup(filename) || 'application/octet-stream';

        db.get(
            "SELECT attachment_original_name, attachment_size, attachment_mime_type FROM messages WHERE attachment_filename = ?",
            [filename],
            (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    filename: filename,
                    originalName: row?.attachment_original_name || filename,
                    size: row?.attachment_size || stats.size,
                    mimeType: row?.attachment_mime_type || mimeType,
                    created: stats.birthtime,
                    modified: stats.mtime
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Статические файлы
app.use('/uploads', express.static(permanentDir));

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер Береста запущен на порту ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log(`📊 База данных: ${dbPath}`);
});
