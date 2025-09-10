const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static('uploads', {
    setHeaders: (res, path) => {
        if (path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.avi')) {
            res.setHeader('Content-Type', 'video/mp4');
        }
    }
}));

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
        cb(null, uniqueSuffix + extension);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit
        fieldSize: 50 * 1024 * 1024  // 50MB для полей
    },
    fileFilter: (req, file, cb) => {
        // Разрешаем все типы файлов
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
        attachment_type TEXT DEFAULT '',
        attachment_filename TEXT DEFAULT '',
        attachment_original_name TEXT DEFAULT '',
        attachment_mime_type TEXT DEFAULT '',
        attachment_size INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        thumbnail TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`);

    // Индексы
    const indexes = [
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)",
        "CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)",
        "CREATE INDEX IF NOT EXISTS idx_messages_attachments ON messages(attachment_type)"
    ];

    indexes.forEach(sql => db.run(sql));
});

// Функция для определения типа файла
function getFileType(mimetype, filename) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('application/pdf')) return 'document';
    if (mimetype.includes('word') || mimetype.includes('excel') || mimetype.includes('powerpoint')) return 'document';
    if (mimetype.includes('zip') || mimetype.includes('rar')) return 'archive';
    return 'file';
}

// Эндпоинт для проверки сервера
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'Server is running',
        timestamp: new Date().toISOString(),
        maxFileSize: '100MB'
    });
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

// Отправка сообщения с файлом
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
              attachment_size, duration, thumbnail) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
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
                attachmentData?.thumbnail || ''
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка БД:', err);
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
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
    const { userEmail, friendEmail } = req.params;
    
    db.all(
        `SELECT * FROM messages 
         WHERE (sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?) 
         ORDER BY timestamp ASC`,
        [userEmail, friendEmail, friendEmail, userEmail],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            const messages = rows.map(row => ({
                ...row,
                attachment_url: row.attachment_filename ? `/uploads/${row.attachment_filename}` : null
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

    res.json({
        success: true,
        file: {
            filename,
            size: stats.size,
            mimeType,
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

    res.download(filePath, req.query.originalname || filename, (err) => {
        if (err) {
            console.error('❌ Ошибка скачивания:', err);
        }
    });
});

// Статические файлы
app.use('/uploads', express.static(uploadDir, {
    setHeaders: (res, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) {
            res.setHeader('Content-Type', 'video/mp4');
        }
    }
}));

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log(`📊 База данных: ${dbPath}`);
});
