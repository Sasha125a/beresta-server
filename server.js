const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Настройка загрузки файлов - используем /tmp для совместимости с Render.com
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
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed'), false);
        }
    }
});

// Инициализация базы данных
const dbPath = process.env.DB_PATH || '/tmp/beresta.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
    } else {
        console.log('✅ Подключение к SQLite базе данных установлено');
        console.log('📊 Путь к БД:', dbPath);
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
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы users:', err.message);
        else console.log('✅ Таблица users создана/проверена');
    });

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email),
        FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (friend_email) REFERENCES users (email) ON DELETE CASCADE
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы friends:', err.message);
        else console.log('✅ Таблица friends создана/проверена');
    });

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        message TEXT NOT NULL,
        attachment_type TEXT DEFAULT '',
        attachment_filename TEXT DEFAULT '',
        attachment_original_name TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_email) REFERENCES users (email) ON DELETE CASCADE,
        FOREIGN KEY (receiver_email) REFERENCES users (email) ON DELETE CASCADE
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы messages:', err.message);
        else console.log('✅ Таблица messages создана/проверена');
    });

    // Создаем индексы для оптимизации запросов
    const indexes = [
        "CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_email)",
        "CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_email)",
        "CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_email)",
        "CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_email)",
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)",
        "CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)"
    ];

    indexes.forEach((sql, index) => {
        db.run(sql, (err) => {
            if (err) console.error(`❌ Ошибка создания индекса ${index + 1}:`, err.message);
        });
    });
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
    console.error('❌ Ошибка БД:', err.message);
    res.status(500).json({ 
        success: false, 
        error: 'Ошибка базы данных',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
}

// Функция для автоматического добавления в чаты при отправке сообщения
function autoAddToChats(senderEmail, receiverEmail) {
    // Проверяем, существует ли получатель
    db.get("SELECT email FROM users WHERE email = ?", [receiverEmail], (err, receiver) => {
        if (err) {
            console.error('❌ Ошибка проверки получателя:', err.message);
            return;
        }

        if (!receiver) {
            console.log('ℹ️ Получатель не существует, пропускаем добавление в чаты');
            return;
        }

        // Проверяем, есть ли уже чат между пользователями (в любую сторону)
        db.get(
            `SELECT 1 FROM messages 
             WHERE (sender_email = ? AND receiver_email = ?) 
                OR (sender_email = ? AND receiver_email = ?) 
             LIMIT 1`,
            [senderEmail, receiverEmail, receiverEmail, senderEmail],
            (err, existingChat) => {
                if (err) {
                    console.error('❌ Ошибка проверки чата:', err.message);
                    return;
                }

                // Если чата еще нет, добавляем обоюдную связь
                if (!existingChat) {
                    console.log(`🤝 Создаем автоматический чат между ${senderEmail} и ${receiverEmail}`);
                    
                    // Добавляем отправителя в чаты получателя
                    db.run(
                        "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)",
                        [receiverEmail, senderEmail],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка добавления в друзья (получатель):', err.message);
                            } else if (this.changes > 0) {
                                console.log(`✅ Автоматически добавлен чат для ${receiverEmail} с ${senderEmail}`);
                            }
                        }
                    );

                    // Добавляем получателя в чаты отправителя
                    db.run(
                        "INSERT OR IGNORE INTO friends (user_email, friend_email) VALUES (?, ?)",
                        [senderEmail, receiverEmail],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка добавления в друзья (отправитель):', err.message);
                            } else if (this.changes > 0) {
                                console.log(`✅ Автоматически добавлен чат для ${senderEmail} с ${receiverEmail}`);
                            }
                        }
                    );
                }
            }
        );
    });
}

// Эндпоинт для проверки файловой системы
app.get('/debug/fs', (req, res) => {
    try {
        const exists = fs.existsSync(uploadDir);
        let writable = false;
        
        if (exists) {
            // Проверка записи
            const testFile = path.join(uploadDir, 'test.txt');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            writable = true;
        } else {
            // Попытка создать
            fs.mkdirSync(uploadDir, { recursive: true });
            writable = true;
        }
        
        res.json({ 
            success: true, 
            uploadDir: {
                exists: exists,
                writable: writable,
                path: uploadDir,
                absolutePath: path.resolve(uploadDir)
            }
        });
    } catch (error) {
        res.json({ 
            success: false, 
            error: error.message,
            uploadDir: {
                exists: fs.existsSync(uploadDir),
                writable: false,
                path: uploadDir,
                absolutePath: path.resolve(uploadDir)
            }
        });
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
                timestamp: new Date().toISOString(),
                database: 'Connected',
                uploadDir: uploadDir,
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

// Удаление аккаунта
app.delete('/delete-account/:email', (req, res) => {
    const email = req.params.email.toLowerCase();
    
    if (!email) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email обязателен' 
        });
    }

    // Проверяем, существует ли пользователь
    db.get("SELECT email FROM users WHERE email = ?", [email], (err, user) => {
        if (err) {
            return handleDatabaseError(err, res);
        }

        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователь не найден' 
            });
        }

        // Удаляем пользователя (каскадное удаление сработает благодаря FOREIGN KEY)
        db.run("DELETE FROM users WHERE email = ?", [email], function(err) {
            if (err) {
                handleDatabaseError(err, res);
            } else if (this.changes === 0) {
                res.status(404).json({ 
                    success: false, 
                    error: 'Пользователь не найден' 
                });
            } else {
                // Удаляем файлы вложений пользователя
                db.all(
                    "SELECT attachment_filename FROM messages WHERE sender_email = ? AND attachment_filename != ''",
                    [email],
                    (err, attachments) => {
                        if (err) {
                            console.error('❌ Ошибка получения списка вложений:', err.message);
                        } else {
                            attachments.forEach(attachment => {
                                const filePath = path.join(uploadDir, attachment.attachment_filename);
                                if (fs.existsSync(filePath)) {
                                    fs.unlinkSync(filePath);
                                }
                            });
                        }
                    }
                );

                res.json({ 
                    success: true, 
                    message: 'Аккаунт и все связанные данные удалены' 
                });
            }
        });
    });
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
    });
});

// Отправка текстового сообщения
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

            // Автоматически добавляем пользователей в чаты друг друга
            autoAddToChats(senderEmail.toLowerCase(), receiverEmail.toLowerCase());

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
                            console.log('❌ Ошибка отправки email:', emailError.message);
                        } else {
                            console.log('✅ Email отправлен:', info.messageId);
                        }
                    });
                } catch (emailError) {
                    console.log('❌ Ошибка при подготовке email:', emailError.message);
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

// Отправка сообщения с вложением
app.post('/send-message-attachment', upload.single('attachment'), (req, res) => {
    console.log('=== 📤 ЗАПРОС НА ОТПРАВКУ МЕДИА ===');
    console.log('🕐 Время:', new Date().toISOString());
    console.log('📎 Файл:', req.file ? {
        originalname: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype
    } : 'No file');
    console.log('📝 Тело запроса:', req.body);
    console.log('====================================');

    const { senderEmail, receiverEmail, message } = req.body;
    
    if (!senderEmail || !receiverEmail) {
        console.log('❌ Отсутствуют обязательные поля');
        return res.status(400).json({ 
            success: false, 
            error: 'Email отправителя и получателя обязательны' 
        });
    }

    if (!req.file) {
        console.log('❌ Файл не загружен');
        return res.status(400).json({ 
            success: false, 
            error: 'Файл не загружен' 
        });
    }

    const trimmedMessage = message ? message.trim() : '';
    const attachmentType = req.file.mimetype.startsWith('image/') ? 'image' : 'video';

    // Сохраняем сообщение с вложением в БД
    db.run(
        "INSERT INTO messages (sender_email, receiver_email, message, attachment_type, attachment_filename, attachment_original_name) VALUES (?, ?, ?, ?, ?, ?)", 
        [
            senderEmail.toLowerCase(), 
            receiverEmail.toLowerCase(), 
            trimmedMessage,
            attachmentType,
            req.file.filename,
            req.file.originalname
        ], 
        function(err) {
            if (err) {
                console.error('❌ Ошибка базы данных:', err.message);
                // Удаляем загруженный файл в случае ошибки
                if (req.file && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
                return handleDatabaseError(err, res);
            }

            // Автоматически добавляем пользователей в чаты друг друга
            autoAddToChats(senderEmail.toLowerCase(), receiverEmail.toLowerCase());

            console.log('✅ Сообщение с вложением сохранено, ID:', this.lastID);

            res.json({ 
                success: true, 
                message: 'Сообщение с вложением отправлено',
                messageId: this.lastID,
                timestamp: new Date().toISOString(),
                attachment: {
                    filename: req.file.filename,
                    originalName: req.file.originalname,
                    type: attachmentType,
                    url: `/uploads/${req.file.filename}`
                }
            });
        }
    );
});

// Получение файла вложения
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(path.resolve(filePath));
    } else {
        console.log('❌ Файл не найден:', filename);
        res.status(404).json({ 
            success: false, 
            error: 'Файл не найден' 
        });
    }
});

// Получение истории сообщений
app.get('/messages/:userEmail/:friendEmail', (req, res) => {
    const userEmail = req.params.userEmail.toLowerCase();
    const friendEmail = req.params.friendEmail.toLowerCase();
    
    db.all(
        `SELECT sender_email, receiver_email, message, 
                attachment_type, attachment_filename, attachment_original_name,
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
                // Добавляем URL для вложений
                const messagesWithAttachments = rows.map(row => {
                    if (row.attachment_filename) {
                        row.attachment_url = `/uploads/${row.attachment_filename}`;
                    }
                    return row;
                });
                
                res.json({ 
                    success: true, 
                    messages: messagesWithAttachments,
                    count: messagesWithAttachments.length 
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

    // Сначала получаем список файлов вложений для удаления
    db.all(
        `SELECT attachment_filename FROM messages 
         WHERE ((sender_email = ? AND receiver_email = ?) 
            OR (sender_email = ? AND receiver_email = ?))
         AND attachment_filename != ''`,
        [userEmail.toLowerCase(), friendEmail.toLowerCase(), 
         friendEmail.toLowerCase(), userEmail.toLowerCase()],
        (err, attachments) => {
            if (err) {
                return handleDatabaseError(err, res);
            }

            // Удаляем файлы вложений
            attachments.forEach(attachment => {
                const filePath = path.join(uploadDir, attachment.attachment_filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            });

            // Теперь удаляем сообщения из БД
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

// Получение всех чатов пользователя (друзья + люди, с которыми есть сообщения)
app.get('/chats/:email', (req, res) => {
    const userEmail = req.params.email.toLowerCase();
    
    db.all(
        `-- Друзья
        SELECT f.friend_email as contact_email, u.first_name, u.last_name, 
               'friend' as type, MAX(m.timestamp) as last_message_time
        FROM friends f 
        JOIN users u ON f.friend_email = u.email 
        LEFT JOIN messages m ON (m.sender_email = ? AND m.receiver_email = f.friend_email) 
                             OR (m.sender_email = f.friend_email AND m.receiver_email = ?)
        WHERE f.user_email = ? 
        GROUP BY f.friend_email
        
        UNION
        
        -- Люди, с которыми есть сообщения, но нет в друзьях
        SELECT 
            CASE 
                WHEN sender_email = ? THEN receiver_email 
                ELSE sender_email 
            END as contact_email,
            u.first_name,
            u.last_name,
            'chat' as type,
            MAX(m.timestamp) as last_message_time
        FROM messages m
        JOIN users u ON u.email = CASE 
                WHEN m.sender_email = ? THEN m.receiver_email 
                ELSE m.sender_email 
            END
        WHERE (sender_email = ? OR receiver_email = ?)
          AND NOT EXISTS (
              SELECT 1 FROM friends f 
              WHERE f.user_email = ? 
              AND f.friend_email = CASE 
                  WHEN m.sender_email = ? THEN m.receiver_email 
                  ELSE m.sender_email 
              END
          )
        GROUP BY contact_email
        
        ORDER BY last_message_time DESC NULLS LAST, first_name, last_name`,
        [userEmail, userEmail, userEmail, userEmail, userEmail, userEmail, userEmail, userEmail, userEmail],
        (err, rows) => {
            if (err) {
                handleDatabaseError(err, res);
            } else {
                res.json({ 
                    success: true, 
                    chats: rows,
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
            (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as messages_today,
            (SELECT COUNT(*) FROM messages WHERE attachment_type != '') as attachments_count`,
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
            'DELETE /delete-account/:email',
            'GET /users',
            'POST /add-friend',
            'POST /remove-friend',
            'GET /friends/:email',
            'GET /chats/:email',
            'POST /send-message',
            'POST /send-message-attachment',
            'GET /messages/:userEmail/:friendEmail',
            'POST /clear-chat',
            'GET /user/:email',
            'GET /stats',
            'GET /health',
            'GET /debug/fs',
            'GET /uploads/:filename'
        ]
    });
});

// Обработка ошибок
app.use((error, req, res, next) => {
    console.error('❌ Необработанная ошибка:', error.message);
    console.error('📋 Stack:', error.stack);
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
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log(`🌐 Режим: ${process.env.NODE_ENV || 'development'}`);
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

process.on('SIGTERM', () => {
    console.log('\n🛑 Получен сигнал SIGTERM...');
    db.close((err) => {
        if (err) {
            console.error('❌ Ошибка закрытия БД:', err.message);
        } else {
            console.log('✅ Подключение к БД закрыто');
        }
        process.exit(0);
    });
});
