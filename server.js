const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const activeCalls = new Map();
const Agora = require('agora-access-token');
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// WebSocket соединения
const activeUsers = new Map();

// Устанавливаем пути к ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const tempDir = path.join(uploadDir, 'temp');
const permanentDir = path.join(uploadDir, 'permanent');
const thumbnailsDir = path.join(uploadDir, 'thumbnails');

// Создаем необходимые директории
[uploadDir, tempDir, permanentDir, thumbnailsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 Создана папка:', dir);
    } else {
        console.log('📁 Папка уже существует:', dir);
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
const dbPath = process.env.DB_PATH || path.join(__dirname, 'beresta.db');
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

    // Таблица друзей
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email),
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (friend_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Таблица сообщений
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
        attachment_url TEXT DEFAULT '',
        duration INTEGER DEFAULT 0,
        thumbnail TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent',
        downloaded_by_sender BOOLEAN DEFAULT 0,
        downloaded_by_receiver BOOLEAN DEFAULT 0,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Таблица групп
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Таблица участников групп
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_email),
        FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Таблица групповых сообщений
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE CASCADE,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // В создании таблицы users добавим новые поля
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Добавить в создание таблиц в server.js
    db.run(`CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ended',
        duration INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        FOREIGN KEY (caller_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Создайте таблицу для Agora звонков в БД
    db.run(`CREATE TABLE IF NOT EXISTS agora_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        FOREIGN KEY (caller_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Индексы
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_downloads ON messages(downloaded_by_sender, downloaded_by_receiver)");
    db.run("CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id, user_email)");
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
    
    // Дополнительная проверка по расширению
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.3gp'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z', '.tar'].includes(ext)) return 'archive';
    
    return 'file';
}

// Функция создания миниатюры для видео
function createVideoThumbnail(videoPath, outputPath, callback) {
    ffmpeg(videoPath)
        .screenshots({
            timestamps: ['00:00:01'],
            filename: path.basename(outputPath),
            folder: path.dirname(outputPath),
            size: '320x240'
        })
        .on('end', () => {
            console.log('✅ Миниатюра создана:', outputPath);
            callback(null, outputPath);
        })
        .on('error', (err) => {
            console.error('❌ Ошибка создания миниатюры:', err);
            callback(err);
        });
}

// Функция создания превью для медиафайлов
function createMediaPreview(filePath, outputPath, fileType, callback) {
    if (fileType === 'video') {
        // Для видео создаем превью из первого кадра
        ffmpeg(filePath)
            .screenshots({
                timestamps: ['00:00:01'],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '320x240'
            })
            .on('end', () => {
                console.log('✅ Превью видео создано:', outputPath);
                callback(null, outputPath);
            })
            .on('error', (err) => {
                console.error('❌ Ошибка создания превью видео:', err);
                callback(err);
            });
    } else if (fileType === 'image') {
        // Для изображений создаем уменьшенную копию
        ffmpeg(filePath)
            .size('320x240')
            .output(outputPath)
            .on('end', () => {
                console.log('✅ Превью изображения создано:', outputPath);
                callback(null, outputPath);
            })
            .on('error', (err) => {
                console.error('❌ Ошибка создания превью изображения:', err);
                callback(err);
            });
    } else {
        callback(new Error('Unsupported file type for preview'));
    }
}

// Функция получения длительности видео
function getVideoDuration(videoPath, callback) {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
            console.error('❌ Ошибка получения длительности видео:', err);
            return callback(err);
        }
        const duration = Math.round(metadata.format.duration || 0);
        callback(null, duration);
    });
}

// Функция перемещения файла
function moveFileToPermanent(filename) {
    const tempPath = path.join(tempDir, filename);
    const permanentPath = path.join(permanentDir, filename);
    
    if (fs.existsSync(tempPath)) {
        try {
            fs.renameSync(tempPath, permanentPath);
            console.log(`✅ Файл перемещен: ${filename} -> ${permanentPath}`);
            return true;
        } catch (error) {
            console.error(`❌ Ошибка перемещения файла ${filename}:`, error);
            return false;
        }
    } else {
        console.error(`❌ Временный файл не найден: ${tempPath}`);
        return false;
    }
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

// Добавьте эту функцию для валидации имени канала
function isValidChannelName(channelName) {
    // Agora требует: 64 байта максимум, только цифры, буквы и некоторые символы
    const pattern = /^[a-zA-Z0-9!#$%&()+\-:;<=>.?@[\]^_{}|~]{1,64}$/;
    return pattern.test(channelName) && channelName.length <= 64;
}

// Функция для генерации безопасного имени канала
function generateSafeChannelName(baseName) {
    // Удаляем все недопустимые символы
    let safeName = baseName.replace(/[^a-zA-Z0-9!#$%&()+\-:;<=>.?@[\]^_{}|~]/g, '');
    
    // Ограничиваем длину 64 символами
    safeName = safeName.substring(0, 64);
    
    // Если после очистки имя пустое, генерируем случайное
    if (!safeName) {
        safeName = 'channel_' + Math.random().toString(36).substring(2, 15);
    }
    
    return safeName;
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
            upload_dir: uploadDir,
            db_path: dbPath
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
                datetime(timestamp, 'localtime') as timestamp, status
         FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?)
         ORDER BY timestamp ASC`,
        [userEmail, friendEmail, friendEmail, userEmail],
        (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения сообщений:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                messages: rows
            });
        }
    );
});

// Отправка сообщения
app.post('/send-message', (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, duration } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        db.run(
            `INSERT INTO messages (sender_email, receiver_email, message, duration) 
             VALUES (?, ?, ?, ?)`,
            [senderEmail.toLowerCase(), receiverEmail.toLowerCase(), message || '', duration || 0],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    messageId: this.lastID
                });

                // Автоматически добавляем в чаты если это новый диалог
                addToChatsAutomatically(senderEmail, receiverEmail, () => {});
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла (новый эндпоинт для Android приложения)
app.post('/upload-file', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        console.log('📤 Загружен файл:', {
            originalname: req.file.originalname,
            filename: req.file.filename,
            size: req.file.size,
            path: req.file.path
        });

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        const fileUrl = `/uploads/permanent/${req.file.filename}`;

        // Перемещаем файл в постоянную папку
        if (moveFileToPermanent(req.file.filename)) {
            // Проверяем, существует ли файл в постоянной папке
            const permanentPath = path.join(permanentDir, req.file.filename);
            const fileExists = fs.existsSync(permanentPath);
            
            console.log('✅ Файл сохранен:', {
                filename: req.file.filename,
                permanentPath: permanentPath,
                exists: fileExists,
                fileUrl: fileUrl
            });

            res.json({
                success: true,
                filename: req.file.filename,
                originalName: req.file.originalname,
                fileUrl: fileUrl,
                fileType: fileType,
                size: req.file.size,
                mimeType: req.file.mimetype
            });
        } else {
            console.error('❌ Ошибка перемещения файла');
            fs.unlinkSync(req.file.path);
            res.status(500).json({ success: false, error: 'Ошибка сохранения файла' });
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла с сообщением
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const { senderEmail, receiverEmail, duration, message } = req.body;

        if (!senderEmail || !receiverEmail) {
            // Удаляем временный файл если нет email
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = duration || 0;

        // Создаем превью для изображений и видео
        if (fileType === 'image' || fileType === 'video') {
            const previewName = `preview_${path.parse(req.file.filename).name}.jpg`;
            const previewPath = path.join(thumbnailsDir, previewName);

            if (fileType === 'video') {
                // Для видео получаем длительность
                getVideoDuration(req.file.path, (err, duration) => {
                    if (!err && duration > 0) {
                        videoDuration = duration;
                    }
                    createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                        if (!err) {
                            thumbnailFilename = previewName;
                        }
                        completeFileUpload();
                    });
                });
            } else {
                // Для изображений сразу создаем превью
                createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                    if (!err) {
                        thumbnailFilename = previewName;
                    }
                    completeFileUpload();
                });
            }
        } else {
            completeFileUpload();
        }

        function completeFileUpload() {
            db.run(
                `INSERT INTO messages 
                 (sender_email, receiver_email, message, attachment_type, 
                  attachment_filename, attachment_original_name, attachment_mime_type, 
                  attachment_size, duration, thumbnail) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    senderEmail.toLowerCase(),
                    receiverEmail.toLowerCase(),
                    message || '',
                    fileType,
                    req.file.filename,
                    req.file.originalname,
                    req.file.mimetype,
                    req.file.size,
                    videoDuration,
                    thumbnailFilename
                ],
                function(err) {
                    if (err) {
                        fs.unlinkSync(req.file.path);
                        if (thumbnailFilename) {
                            fs.unlinkSync(path.join(thumbnailsDir, thumbnailFilename));
                        }
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    // Перемещаем файл в постоянную папку
                    if (moveFileToPermanent(req.file.filename)) {
                        res.json({
                            success: true,
                            messageId: this.lastID,
                            filename: req.file.filename,
                            thumbnail: thumbnailFilename
                        });

                        // Автоматически добавляем в чаты если это новый диалог
                        addToChatsAutomatically(senderEmail, receiverEmail, () => {});
                    } else {
                        fs.unlinkSync(req.file.path);
                        if (thumbnailFilename) {
                            fs.unlinkSync(path.join(thumbnailsDir, thumbnailFilename));
                        }
                        res.status(500).json({ success: false, error: 'Ошибка сохранения файла' });
                    }
                }
            );
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отправка сообщения с информацией о файле
app.post('/send-message-with-attachment', (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, attachmentType, 
                attachmentFilename, attachmentOriginalName, attachmentUrl } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        db.run(
            `INSERT INTO messages 
             (sender_email, receiver_email, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_url) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                senderEmail.toLowerCase(),
                receiverEmail.toLowerCase(),
                message || '',
                attachmentType || '',
                attachmentFilename || '',
                attachmentOriginalName || '',
                attachmentUrl || ''
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка отправки сообщения с вложением:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    messageId: this.lastID
                });

                // Автоматически добавляем в чаты если это новый диалог
                addToChatsAutomatically(senderEmail, receiverEmail, () => {});
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения с вложением:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Скачивание файла
app.get('/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const messageId = req.query.messageId;
        const userEmail = req.query.userEmail;
        const isSender = req.query.isSender === 'true';

        const filePath = path.join(permanentDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        // Обновляем статус скачивания
        if (messageId && userEmail) {
            updateDownloadStatus(messageId, userEmail, isSender);
        }

        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        const originalName = req.query.originalName || filename;

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

        fileStream.on('error', (err) => {
            console.error('❌ Ошибка отправки файла:', err);
            res.status(500).json({ success: false, error: 'Ошибка отправки файла' });
        });

    } catch (error) {
        console.error('❌ Ошибка скачивания файла:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о файле по ID сообщения
app.get('/file-info/:messageId', (req, res) => {
    try {
        const messageId = req.params.messageId;

        db.get(
            `SELECT attachment_filename, attachment_original_name, 
                    attachment_mime_type, attachment_size, attachment_type
             FROM messages WHERE id = ?`,
            [messageId],
            (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                if (!row || !row.attachment_filename) {
                    return res.status(404).json({ success: false, error: 'Файл не найден' });
                }

                const filePath = path.join(permanentDir, row.attachment_filename);
                const exists = fs.existsSync(filePath);

                res.json({
                    success: true,
                    exists: exists,
                    filename: row.attachment_filename,
                    originalName: row.attachment_original_name,
                    mimeType: row.attachment_mime_type,
                    size: row.attachment_size,
                    type: row.attachment_type
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о файле по имени файла
app.get('/file-info-by-name/:filename', (req, res) => {
    try {
        const filename = req.params.filename;

        db.get(
            `SELECT attachment_original_name, attachment_mime_type, 
                    attachment_size, attachment_type
             FROM messages WHERE attachment_filename = ?`,
            [filename],
            (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                if (!row) {
                    return res.status(404).json({ success: false, error: 'Файл не найден' });
                }

                const filePath = path.join(permanentDir, filename);
                const exists = fs.existsSync(filePath);

                res.json({
                    success: true,
                    exists: exists,
                    filename: filename,
                    originalName: row.attachment_original_name,
                    mimeType: row.attachment_mime_type,
                    size: row.attachment_size,
                    type: row.attachment_type
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Проверка существования файла
app.get('/check-file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(permanentDir, filename);
    
    if (fs.existsSync(filePath)) {
        res.json({
            exists: true,
            path: filePath,
            size: fs.statSync(filePath).size
        });
    } else {
        res.json({
            exists: false,
            path: filePath,
            error: 'File not found'
        });
    }
});

// Создание группы
app.post('/create-group', (req, res) => {
    try {
        const { name, description, createdBy, members } = req.body;

        if (!name || !createdBy) {
            return res.status(400).json({ success: false, error: 'Название и создатель обязательны' });
        }

        db.run(
            "INSERT INTO groups (name, description, created_by) VALUES (?, ?, ?)",
            [name, description || '', createdBy.toLowerCase()],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                const groupId = this.lastID;

                // Добавляем создателя в группу
                db.run(
                    "INSERT INTO group_members (group_id, user_email, role) VALUES (?, ?, 'admin')",
                    [groupId, createdBy.toLowerCase()],
                    function(err) {
                        if (err) {
                            return res.status(500).json({ success: false, error: 'Database error' });
                        }

                        // Добавляем остальных участников если есть
                        if (members && members.length > 0) {
                            const stmt = db.prepare(
                                "INSERT INTO group_members (group_id, user_email) VALUES (?, ?)"
                            );

                            members.forEach(member => {
                                if (member !== createdBy) {
                                    stmt.run([groupId, member.toLowerCase()]);
                                }
                            });

                            stmt.finalize();
                        }

                        res.json({
                            success: true,
                            groupId: groupId,
                            message: 'Группа создана'
                        });
                    }
                );
            }
        );
    } catch (error) {
        console.error('❌ Ошибка создания группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение списка групп пользователя
app.get('/groups/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.all(`
            SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                   gm.role, COUNT(gm2.user_email) as member_count
            FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            LEFT JOIN group_members gm2 ON g.id = gm2.group_id
            WHERE gm.user_email = ?
            GROUP BY g.id, g.name, g.description, g.created_by, g.created_at, gm.role
            ORDER BY g.name
        `, [userEmail], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                groups: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения групп:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение участников группы
app.get('/group-members/:groupId', (req, res) => {
    try {
        const groupId = req.params.groupId;

        db.all(`
            SELECT u.email, u.first_name, u.last_name, gm.role, gm.joined_at
            FROM group_members gm
            JOIN users u ON gm.user_email = u.email
            WHERE gm.group_id = ?
            ORDER BY gm.role DESC, u.first_name, u.last_name
        `, [groupId], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                members: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения участников группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отправка сообщения в группу
app.post('/send-group-message', (req, res) => {
    try {
        const { groupId, senderEmail, message, duration } = req.body;

        if (!groupId || !senderEmail) {
            return res.status(400).json({ success: false, error: 'Группа и отправитель обязательны' });
        }

        db.run(
            `INSERT INTO group_messages (group_id, sender_email, message, duration) 
             VALUES (?, ?, ?, ?)`,
            [groupId, senderEmail.toLowerCase(), message || '', duration || 0],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    messageId: this.lastID
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки группового сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла в группу
app.post('/upload-group', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const { groupId, senderEmail, duration, message } = req.body;

        if (!groupId || !senderEmail) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Группа и отправитель обязательны' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = duration || 0;

        // Создаем превью для изображений и видео в группах
        if (fileType === 'image' || fileType === 'video') {
            const previewName = `preview_${path.parse(req.file.filename).name}.jpg`;
            const previewPath = path.join(thumbnailsDir, previewName);

            if (fileType === 'video') {
                getVideoDuration(req.file.path, (err, duration) => {
                    if (!err && duration > 0) {
                        videoDuration = duration;
                    }
                    createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                        if (!err) {
                            thumbnailFilename = previewName;
                        }
                        completeGroupFileUpload();
                    });
                });
            } else {
                createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                    if (!err) {
                        thumbnailFilename = previewName;
                    }
                    completeGroupFileUpload();
                });
            }
        } else {
            completeGroupFileUpload();
        }

        function completeGroupFileUpload() {
            db.run(
                `INSERT INTO group_messages 
                 (group_id, sender_email, message, attachment_type, 
                  attachment_filename, attachment_original_name, attachment_mime_type, 
                  attachment_size, duration, thumbnail) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    groupId,
                    senderEmail.toLowerCase(),
                    message || '',
                    fileType,
                    req.file.filename,
                    req.file.originalname,
                    req.file.mimetype,
                    req.file.size,
                    videoDuration,
                    thumbnailFilename
                ],
                function(err) {
                    if (err) {
                        fs.unlinkSync(req.file.path);
                        if (thumbnailFilename) {
                            fs.unlinkSync(path.join(thumbnailsDir, thumbnailFilename));
                        }
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    if (moveFileToPermanent(req.file.filename)) {
                        res.json({
                            success: true,
                            messageId: this.lastID,
                            filename: req.file.filename,
                            thumbnail: thumbnailFilename
                        });
                    } else {
                        fs.unlinkSync(req.file.path);
                        if (thumbnailFilename) {
                            fs.unlinkSync(path.join(thumbnailsDir, thumbnailFilename));
                        }
                        res.status(500).json({ success: false, error: 'Ошибка сохранения файла' });
                    }
                }
            );
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки файла в группу:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение сообщений группы
app.get('/group-messages/:groupId', (req, res) => {
    try {
        const groupId = req.params.groupId;

        db.all(`
            SELECT gm.id, gm.sender_email, gm.message, 
                   gm.attachment_type, gm.attachment_filename, gm.attachment_original_name,
                   gm.attachment_mime_type, gm.attachment_size, gm.duration, gm.thumbnail,
                   datetime(gm.timestamp, 'localtime') as timestamp,
                   u.first_name, u.last_name
            FROM group_messages gm
            JOIN users u ON gm.sender_email = u.email
            WHERE gm.group_id = ?
            ORDER BY gm.timestamp ASC
        `, [groupId], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                messages: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения групповых сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление участника в группу
app.post('/add-group-member', (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        db.run(
            "INSERT OR IGNORE INTO group_members (group_id, user_email) VALUES (?, ?)",
            [groupId, userEmail.toLowerCase()],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Участник добавлен'
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка добавления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление участника из группы
app.post('/remove-group-member', (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        db.run(
            "DELETE FROM group_members WHERE group_id = ? AND user_email = ?",
            [groupId, userEmail.toLowerCase()],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Участник удален'
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка удаления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление группы
app.delete('/group/:groupId', (req, res) => {
    try {
        const groupId = req.params.groupId;

        db.run("DELETE FROM groups WHERE id = ?", [groupId], function(err) {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                message: 'Группа удалена'
            });
        });
    } catch (error) {
        console.error('❌ Ошибка удаления группы:', error);
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
                    message: 'Статус обновлен'
                });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка обновления статуса:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение непрочитанных сообщений
app.get('/unread-messages/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.all(`
            SELECT m.id, m.sender_email, m.receiver_email, m.message, 
                   m.attachment_type, m.attachment_filename, m.attachment_original_name,
                   datetime(m.timestamp, 'localtime') as timestamp,
                   u.first_name, u.last_name
            FROM messages m
            JOIN users u ON m.sender_email = u.email
            WHERE m.receiver_email = ? AND m.status = 'sent'
            ORDER BY m.timestamp ASC
        `, [userEmail], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                unreadMessages: rows
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения непрочитанных сообщений:', error);
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

// Удаление аккаунта
app.delete('/delete-account/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.run("DELETE FROM users WHERE email = ?", [userEmail], function(err) {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                message: 'Аккаунт удален',
                deletedCount: this.changes
            });
        });
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавьте этот endpoint в server.js после существующих POST endpoints
app.post('/send-message-with-attachment', (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, attachmentType, 
                attachmentFilename, attachmentOriginalName, attachmentUrl } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        db.run(
            `INSERT INTO messages 
             (sender_email, receiver_email, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_url) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                senderEmail.toLowerCase(),
                receiverEmail.toLowerCase(),
                message || '',
                attachmentType || '',
                attachmentFilename || '',
                attachmentOriginalName || '',
                attachmentUrl || ''
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка отправки сообщения с вложением:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    messageId: this.lastID
                });

                // Автоматически добавляем в чаты если это новый диалог
                addToChatsAutomatically(senderEmail, receiverEmail, () => {});
            }
        );
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения с вложением:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Эндпоинт для получения информации о пользователе
app.get('/user/:email', (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        db.get(`SELECT email, first_name as firstName, last_name as lastName, 
                avatar_filename as avatarFilename FROM users WHERE email = ?`, 
        [email], (err, row) => {
            if (err) {
                console.error('❌ Ошибка БД при получении пользователя:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (!row) {
                return res.status(404).json({ success: false, error: 'Пользователь не найден' });
            }

            res.json({
                success: true,
                user: row
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Эндпоинт для обновления профиля
app.post('/update-profile', upload.single('avatar'), (req, res) => {
    try {
        const { email, firstName, lastName, removeAvatar } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, error: 'Email обязателен' });
        }

        let avatarFilename = '';

        // Обработка аватара
        if (req.file) {
            // Перемещаем файл в постоянную папку
            if (moveFileToPermanent(req.file.filename)) {
                avatarFilename = req.file.filename;
            }
        } else if (removeAvatar === 'true') {
            // Удаляем аватар
            avatarFilename = '';
        }

        let query = "UPDATE users SET first_name = ?, last_name = ?";
        let params = [firstName, lastName];

        if (avatarFilename !== undefined) {
            query += ", avatar_filename = ?";
            params.push(avatarFilename);
        }

        query += " WHERE email = ?";
        params.push(email.toLowerCase());

        db.run(query, params, function(err) {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            // Получаем обновленные данные пользователя
            db.get(`SELECT email, first_name as firstName, last_name as lastName, 
                    avatar_filename as avatarFilename FROM users WHERE email = ?`, 
            [email.toLowerCase()], (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Профиль обновлен',
                    user: row
                });
            });
        });
    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Инициализация звонка
app.post('/call/initiate', (req, res) => {
    try {
        const { callerEmail, receiverEmail, callType } = req.body; // 'audio' или 'video'

        if (!callerEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const callId = uuidv4();
        const callData = {
            callId,
            callerEmail: callerEmail.toLowerCase(),
            receiverEmail: receiverEmail.toLowerCase(),
            callType: callType || 'audio',
            status: 'ringing',
            createdAt: new Date().toISOString(),
            offer: null,
            answer: null,
            iceCandidates: []
        };

        activeCalls.set(callId, callData);

        // Отправляем уведомление получателю (в реальном приложении используйте WebSockets)
        // Здесь просто возвращаем данные вызова

        res.json({
            success: true,
            callId,
            callData
        });

    } catch (error) {
        console.error('❌ Ошибка инициализации звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отмена звонка
app.post('/call/cancel', (req, res) => {
    try {
        const { callId } = req.body;

        if (!callId) {
            return res.status(400).json({ success: false, error: 'ID звонка обязателен' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.status = 'cancelled';
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'Звонок отменен' });

    } catch (error) {
        console.error('❌ Ошибка отмены звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Принятие звонка
app.post('/call/accept', (req, res) => {
    try {
        const { callId } = req.body;

        if (!callId) {
            return res.status(400).json({ success: false, error: 'ID звонка обязателен' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.status = 'accepted';
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'Звонок принят' });

    } catch (error) {
        console.error('❌ Ошибка принятия звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отклонение звонка
app.post('/call/reject', (req, res) => {
    try {
        const { callId } = req.body;

        if (!callId) {
            return res.status(400).json({ success: false, error: 'ID звонка обязателен' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.status = 'rejected';
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'Звонок отклонен' });

    } catch (error) {
        console.error('❌ Ошибка отклонения звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Завершение звонка
app.post('/call/end', (req, res) => {
    try {
        const { callId, duration } = req.body;

        if (!callId) {
            return res.status(400).json({ success: false, error: 'ID звонка обязателен' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.status = 'ended';
            callData.endedAt = new Date().toISOString();
            callData.duration = duration || 0;
            activeCalls.set(callId, callData);

            // Сохраняем информацию о звонке в БД
            db.run(
                `INSERT INTO calls (call_id, caller_email, receiver_email, call_type, duration, status)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [callId, callData.callerEmail, callData.receiverEmail, 
                 callData.callType, callData.duration, callData.status],
                (err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения звонка:', err);
                    }
                }
            );
        }

        res.json({ success: true, message: 'Звонок завершен' });

    } catch (error) {
        console.error('❌ Ошибка завершения звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение статуса звонка
app.get('/call/status/:callId', (req, res) => {
    try {
        const callId = req.params.callId;

        if (activeCalls.has(callId)) {
            res.json({
                success: true,
                callData: activeCalls.get(callId)
            });
        } else {
            res.status(404).json({ success: false, error: 'Звонок не найден' });
        }

    } catch (error) {
        console.error('❌ Ошибка получения статуса звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// WebRTC signaling - отправка offer
app.post('/call/offer', (req, res) => {
    try {
        const { callId, offer } = req.body;

        if (!callId || !offer) {
            return res.status(400).json({ success: false, error: 'ID звонка и offer обязательны' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.offer = offer;
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'Offer получен' });

    } catch (error) {
        console.error('❌ Ошибка обработки offer:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// WebRTC signaling - отправка answer
app.post('/call/answer', (req, res) => {
    try {
        const { callId, answer } = req.body;

        if (!callId || !answer) {
            return res.status(400).json({ success: false, error: 'ID звонка и answer обязательны' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.answer = answer;
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'Answer получен' });

    } catch (error) {
        console.error('❌ Ошибка обработки answer:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// WebRTC signaling - отправка ICE candidate
app.post('/call/ice-candidate', (req, res) => {
    try {
        const { callId, candidate } = req.body;

        if (!callId || !candidate) {
            return res.status(400).json({ success: false, error: 'ID звонка и candidate обязательны' });
        }

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            callData.iceCandidates.push(candidate);
            activeCalls.set(callId, callData);
        }

        res.json({ success: true, message: 'ICE candidate получен' });

    } catch (error) {
        console.error('❌ Ошибка обработки ICE candidate:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение ICE candidates
app.get('/call/ice-candidates/:callId', (req, res) => {
    try {
        const callId = req.params.callId;

        if (activeCalls.has(callId)) {
            const callData = activeCalls.get(callId);
            res.json({
                success: true,
                candidates: callData.iceCandidates
            });
        } else {
            res.status(404).json({ success: false, error: 'Звонок не найден' });
        }

    } catch (error) {
        console.error('❌ Ошибка получения ICE candidates:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Очистка старых звонков
setInterval(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const [callId, callData] of activeCalls.entries()) {
        const callTime = new Date(callData.createdAt).getTime();
        if (now - callTime > oneHour) {
            activeCalls.delete(callId);
            console.log(`🗑️  Удален старый звонок: ${callId}`);
        }
    }
}, 30 * 60 * 1000);

// Получение pending calls для пользователя
app.get('/pending-calls/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        
        const pendingCalls = Array.from(activeCalls.values()).filter(call => 
            call.receiverEmail === userEmail && call.status === 'ringing'
        );
        
        res.json({
            success: true,
            calls: pendingCalls
        });
    } catch (error) {
        console.error('❌ Ошибка получения pending calls:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ЗАМЕНИТЕ текущий POST endpoint на этот GET endpoint:
app.get('/agora/token/:channelName/:userId', (req, res) => {
    try {
        const { channelName, userId } = req.params;

        if (!channelName) {
            return res.status(400).json({ success: false, error: 'Channel name обязателен' });
        }

        // Валидация имени канала
        if (!isValidChannelName(channelName)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Недопустимое имя канала. Разрешены только буквы, цифры и некоторые символы' 
            });
        }

        // Ваши Agora credentials
        const appId = process.env.AGORA_APP_ID || '0eef2fbc530f4d27a19a18f6527dda20';
        const appCertificate = process.env.AGORA_APP_CERTIFICATE || '5ffaa1348ef5433b8fbb37d22772ca0e';
        const expirationTimeInSeconds = 3600; // 1 час

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

        // Преобразуем userId в число, убеждаемся что оно положительное
        const uid = Math.abs(parseInt(userId) || 0);
        
        const token = Agora.RtcTokenBuilder.buildTokenWithUid(
            appId,
            appCertificate,
            channelName,
            uid,
            Agora.RtcRole.PUBLISHER,
            privilegeExpiredTs
        );

        res.json({
            success: true,
            token: token,
            appId: appId,
            channelName: channelName
        });

    } catch (error) {
        console.error('❌ Ошибка генерации Agora токена:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/agora/create-call', (req, res) => {
    try {
        const { callerEmail, receiverEmail, callType, channelName } = req.body;

        if (!callerEmail || !receiverEmail || !channelName) {
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        // Валидация имени канала
        if (!isValidChannelName(channelName)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Недопустимое имя канала' 
            });
        }

        // Сохраняем информацию о звонке в БД
        db.run(
            `INSERT INTO agora_calls (channel_name, caller_email, receiver_email, call_type, status)
             VALUES (?, ?, ?, ?, 'ringing')`,
            [channelName, callerEmail.toLowerCase(), receiverEmail.toLowerCase(), callType || 'audio'],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    callId: this.lastID,
                    channelName: channelName
                });
            }
        );

    } catch (error) {
        console.error('❌ Ошибка создания Agora звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/agora/end-call', (req, res) => {
    try {
        const { channelName } = req.body;

        if (!channelName) {
            return res.status(400).json({ success: false, error: 'Channel name обязателен' });
        }

        db.run(
            "UPDATE agora_calls SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE channel_name = ?",
            [channelName],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    message: 'Звонок завершен'
                });
            }
        );

    } catch (error) {
        console.error('❌ Ошибка завершения Agora звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/agora/active-calls/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        db.all(`
            SELECT channel_name as channelName, caller_email as callerEmail, 
                   receiver_email as receiverEmail, call_type as callType, 
                   status, created_at as createdAt
            FROM agora_calls 
            WHERE (caller_email = ? OR receiver_email = ?) 
            AND status = 'ringing'
            ORDER BY created_at DESC
        `, [userEmail, userEmail], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            res.json({
                success: true,
                calls: rows
            });
        });

    } catch (error) {
        console.error('❌ Ошибка получения активных Agora звонков:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Эндпоинт для отправки уведомлений о звонках
app.post('/send-call-notification', (req, res) => {
  try {
    const { channelName, receiverEmail, callType } = req.body;

    // Отправляем через WebSocket
    const receiverSocketId = activeUsers.get(receiverEmail);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('incoming_call', {
        channelName,
        callerEmail: req.body.callerEmail, // Добавьте callerEmail в запрос
        callType
      });
    }

    res.json({ success: true, message: 'Уведомление отправлено' });
  } catch (error) {
    console.error('❌ Ошибка отправки уведомления:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// server.js - ИСПРАВЛЕННАЯ ВЕРСИЯ
io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);

  socket.on('user_online', (data) => {
    activeUsers.set(data.email, socket.id);
    console.log(`👤 Пользователь онлайн: ${data.email}`);
  });

  socket.on('call_notification', (data) => {
    const receiverSocketId = activeUsers.get(data.receiverEmail);
    if (receiverSocketId) {
      // ИСПРАВЛЕНО: Правильное имя события
      io.to(receiverSocketId).emit('AGORA_INCOMING_CALL', {
        channelName: data.channelName,
        callerEmail: data.callerEmail,
        callType: data.callType
      });
      console.log(`📞 Уведомление о звонке отправлено: ${data.channelName} -> ${data.receiverEmail}`);
    } else {
      console.log(`⚠️  Пользователь не в сети: ${data.receiverEmail}`);
    }
  });

  socket.on('end_call', (data) => {
    const receiverSocketId = activeUsers.get(data.receiverEmail);
    if (receiverSocketId) {
      // ИСПРАВЛЕНО: Правильное имя события
      io.to(receiverSocketId).emit('AGORA_CALL_ENDED', {
        channelName: data.channelName
      });
    }
  });

  socket.on('disconnect', () => {
    for (let [email, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(email);
        console.log(`👤 Пользователь отключился: ${email}`);
        break;
      }
    }
  });
});

// Статические файлы (для доступа к загруженным файлам)
app.use('/uploads', express.static(uploadDir));

// Очистка временных файлов
function cleanupTempFiles() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    fs.readdir(tempDir, (err, files) => {
        if (err) {
            console.error('❌ Ошибка чтения временной папки:', err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && stats && (now - stats.mtimeMs) > oneHour) {
                    fs.unlink(filePath, (err) => {
                        if (!err) {
                            console.log(`🗑️  Удален временный файл: ${file}`);
                        }
                    });
                }
            });
        });
    });
}

// Запускаем очистку каждые 30 минут
setInterval(cleanupTempFiles, 30 * 60 * 1000);

// Обработка ошибок
app.use((err, req, res, next) => {
    console.error('❌ Необработанная ошибка:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 обработчик
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Запуск сервера
// Замените app.listen на server.listen
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 WebSocket сервер активен`);
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

module.exports = app;
