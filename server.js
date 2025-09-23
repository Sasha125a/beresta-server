const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
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
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// PostgreSQL подключение
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 🔥 ДОБАВЬТЕ ЭТОТ КОД ДЛЯ ЛОГИРОВАНИЯ ПОДКЛЮЧЕНИЯ:
console.log('🔄 Попытка подключения к базе данных...');
console.log(`📊 Database URL: ${process.env.DATABASE_URL ? 'Найден' : 'Не найден'}`);

// Проверка подключения при старте
pool.query('SELECT NOW() as current_time')
  .then(result => {
    console.log('✅ Подключение к PostgreSQL установлено');
    console.log(`⏰ Время базы данных: ${result.rows[0].current_time}`);
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    console.error('🔧 Проверьте:');
    console.error('   - DATABASE_URL в переменных окружения');
    console.error('   - Доступность базы данных');
    console.error('   - Сетевые настройки');
  });

// Обработчики событий подключения
pool.on('connect', () => {
  console.log('🔗 Новое подключение к БД установлено');
});

pool.on('error', (err) => {
  console.error('💥 Критическая ошибка базы данных:', err);
});

pool.on('remove', () => {
  console.log('🔌 Подключение к БД закрыто');
});

// WebSocket соединения
const activeUsers = new Map();

// Устанавливаем пути к ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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

const multerStorage = multer.diskStorage({
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
    storage: multerStorage,
    limits: {
        fileSize: 100 * 1024 * 1024,
        fieldSize: 50 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

// Инициализация Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin инициализирован');
} catch (error) {
  console.error('❌ Ошибка инициализации Firebase:', error);
}

// Проверка Firebase (без отправки тестового уведомления)
admin.auth().getUser('test-user-id')
  .then(() => {
    console.log('✅ Firebase Admin настроен корректно');
  })
  .catch(error => {
    if (error.code === 'auth/user-not-found') {
      console.log('✅ Firebase Admin подключен (ожидаемая ошибка для тестового пользователя)');
    } else {
      console.error('❌ Ошибка Firebase Admin:', error.message);
    }
  });

// Функция для создания таблиц
async function createTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Создание/проверка таблиц...');

    // Перенесите объявление таблицы fcm_tokens в начало массива queries
    const queries = [
      // Таблица для FCM токенов ДОЛЖНА БЫТЬ ОБЪЯВЛЕНА КАК СТРОКА
      `CREATE TABLE IF NOT EXISTS fcm_tokens (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        fcm_token TEXT NOT NULL,
        platform TEXT DEFAULT 'android',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, fcm_token)
      )`,

      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email)
      )`,

      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
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
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent',
        downloaded_by_sender BOOLEAN DEFAULT FALSE,
        downloaded_by_receiver BOOLEAN DEFAULT FALSE
      )`,

      `CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_email)
      )`,

      `CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
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
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        call_id TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ended',
        duration INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS agora_calls (
        id SERIAL PRIMARY KEY,
        channel_name TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        receiver_email TEXT NOT NULL,
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      )`,

      // Индексы
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`
    ];

    for (const query of queries) {
      try {
        await client.query(query);
        console.log(`✅ Таблица/индекс создан`);
      } catch (tableError) {
        console.error('❌ Ошибка создания:', tableError.message);
      }
    }
    
    console.log('✅ Все таблицы созданы/проверены');
    
  } catch (error) {
    console.error('❌ Ошибка создания таблиц:', error);
  } finally {
    client.release();
  }
}

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
    
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.3gp'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z', '.tar'].includes(ext)) return 'archive';
    
    return 'file';
}

// Функция создания превью для медиафайлов
function createMediaPreview(filePath, outputPath, fileType, callback) {
    if (fileType === 'video') {
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

// Функция проверки и удаления файла если оба пользователя скачали
async function checkAndDeleteFile(messageId, filename) {
    try {
        const result = await pool.query(
            `SELECT downloaded_by_sender, downloaded_by_receiver FROM messages WHERE id = $1`,
            [messageId]
        );

        if (result.rows.length > 0) {
            const row = result.rows[0];
            if (row.downloaded_by_sender && row.downloaded_by_receiver) {
                const filePath = path.join(permanentDir, filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️  Файл удален: ${filename}`);
                }
            }
        }
    } catch (err) {
        console.error('❌ Ошибка проверки статуса скачивания:', err);
    }
}

// Функция обновления статуса скачивания
async function updateDownloadStatus(messageId, userEmail, isSender) {
    try {
        const field = isSender ? 'downloaded_by_sender' : 'downloaded_by_receiver';
        
        await pool.query(
            `UPDATE messages SET ${field} = true WHERE id = $1`,
            [messageId]
        );
        
        // Проверяем нужно ли удалить файл
        const result = await pool.query(
            `SELECT attachment_filename FROM messages WHERE id = $1`,
            [messageId]
        );
        
        if (result.rows.length > 0 && result.rows[0].attachment_filename) {
            await checkAndDeleteFile(messageId, result.rows[0].attachment_filename);
        }
    } catch (err) {
        console.error('❌ Ошибка обновления статуса скачивания:', err);
    }
}

// ФУНКЦИЯ ОТПРАВКИ PUSH-УВЕДОМЛЕНИЙ О ЗВОНКАХ
async function sendCallNotification(userEmail, callerEmail, channelName, callType) {
  try {
    const result = await pool.query(
      'SELECT fcm_token FROM fcm_tokens WHERE user_email = $1',
      [userEmail.toLowerCase()]
    );

    if (result.rows.length === 0) {
      console.log(`❌ FCM токен не найден для пользователя: ${userEmail}`);
      return false;
    }

    const fcmToken = result.rows[0].fcm_token;

    const message = {
      token: fcmToken,
      notification: {
        title: 'Входящий звонок',
        body: `${callerEmail} вызывает вас`
      },
      data: {
        type: 'incoming_call',
        channelName: channelName,
        callerEmail: callerEmail,
        callType: callType,
        timestamp: new Date().toISOString(),
        click_action: 'ACCEPT_CALL' // Важно для открытия приложения
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'calls_channel'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            category: 'INCOMING_CALL'
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log(`✅ Push-уведомление о звонке отправлено: ${response}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки push-уведомления о звонке:', error);
    return false;
  }
}

// Функция автоматического добавления в чаты
async function addToChatsAutomatically(user1, user2) {
    try {
        const result = await pool.query(
            "SELECT COUNT(*) as count FROM users WHERE email IN ($1, $2)",
            [user1.toLowerCase(), user2.toLowerCase()]
        );

        if (parseInt(result.rows[0].count) !== 2) {
            console.log('⚠️  Один или оба пользователя не найдены');
            return;
        }

        await pool.query(
            "INSERT INTO friends (user_email, friend_email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [user1.toLowerCase(), user2.toLowerCase()]
        );

        await pool.query(
            "INSERT INTO friends (user_email, friend_email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [user2.toLowerCase(), user1.toLowerCase()]
        );

        console.log(`✅ Автоматически добавлены чаты: ${user1} ↔️ ${user2}`);
    } catch (error) {
        console.error('❌ Ошибка автоматического добавления в чаты:', error);
    }
}

// Валидация имени канала Agora
function isValidChannelName(channelName) {
    const pattern = /^[a-zA-Z0-9!#$%&()+\-:;<=>.?@[\]^_{}|~]{1,64}$/;
    return pattern.test(channelName) && channelName.length <= 64;
}

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            success: true, 
            status: 'Server is running',
            timestamp: new Date().toISOString(),
            database: 'PostgreSQL'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Регистрация пользователя
app.post('/register', async (req, res) => {
    try {
        const { email, firstName, lastName } = req.body;

        if (!email || !firstName || !lastName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Все поля обязательны' 
            });
        }

        const existingUser = await pool.query(
            "SELECT id FROM users WHERE email = $1", 
            [email.toLowerCase()]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ 
                success: false, 
                error: 'Пользователь уже существует' 
            });
        }

        const result = await pool.query(
            "INSERT INTO users (email, first_name, last_name) VALUES ($1, $2, $3) RETURNING *",
            [email.toLowerCase(), firstName, lastName]
        );

        res.json({
            success: true,
            message: 'Пользователь успешно зарегистрирован',
            userId: result.rows[0].id
        });

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение всех пользователей
app.get('/users', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT email, first_name as \"firstName\", last_name as \"lastName\" FROM users ORDER BY first_name, last_name"
        );

        res.json({
            success: true,
            users: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователей:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление в друзья
app.post('/add-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const usersResult = await pool.query(
            "SELECT COUNT(*) as count FROM users WHERE email IN ($1, $2)",
            [userEmail.toLowerCase(), friendEmail.toLowerCase()]
        );

        if (parseInt(usersResult.rows[0].count) !== 2) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователи не найдены' 
            });
        }

        await pool.query(
            "INSERT INTO friends (user_email, friend_email) VALUES ($1, $2) ON CONFLICT (user_email, friend_email) DO NOTHING",
            [userEmail.toLowerCase(), friendEmail.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'Друг добавлен'
        });

    } catch (error) {
        console.error('❌ Ошибка добавления друга:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление из друзей
app.post('/remove-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        await pool.query(
            "DELETE FROM friends WHERE user_email = $1 AND friend_email = $2",
            [userEmail.toLowerCase(), friendEmail.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'Друг удален'
        });

    } catch (error) {
        console.error('❌ Ошибка удаления друга:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение чатов пользователя
app.get('/chats/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const result = await pool.query(`
            SELECT 
                u.email as "contactEmail",
                u.first_name as "firstName",
                u.last_name as "lastName",
                'friend' as type,
                MAX(m.timestamp) as "lastMessageTime"
            FROM friends f
            JOIN users u ON u.email = f.friend_email
            LEFT JOIN messages m ON 
                (m.sender_email = f.user_email AND m.receiver_email = f.friend_email) OR
                (m.sender_email = f.friend_email AND m.receiver_email = f.user_email)
            WHERE f.user_email = $1
            GROUP BY u.email, u.first_name, u.last_name
            
            UNION
            
            SELECT 
                CASE 
                    WHEN m.sender_email = $2 THEN m.receiver_email
                    ELSE m.sender_email
                END as "contactEmail",
                u.first_name as "firstName",
                u.last_name as "lastName",
                'chat' as type,
                MAX(m.timestamp) as "lastMessageTime"
            FROM messages m
            JOIN users u ON u.email = CASE 
                WHEN m.sender_email = $2 THEN m.receiver_email
                ELSE m.sender_email
            END
            WHERE (m.sender_email = $2 OR m.receiver_email = $2)
            AND NOT EXISTS (
                SELECT 1 FROM friends f 
                WHERE f.user_email = $2 
                AND f.friend_email = CASE 
                    WHEN m.sender_email = $2 THEN m.receiver_email
                    ELSE m.sender_email
                END
            )
            GROUP BY "contactEmail", u.first_name, u.last_name
            
            ORDER BY "lastMessageTime" DESC NULLS LAST, "firstName", "lastName"
        `, [userEmail, userEmail]);

        res.json({
            success: true,
            chats: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения чатов:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение сообщений
app.get('/messages/:userEmail/:friendEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        const friendEmail = req.params.friendEmail.toLowerCase();

        const result = await pool.query(`
            SELECT id, sender_email, receiver_email, message, 
                   attachment_type, attachment_filename, attachment_original_name,
                   attachment_mime_type, attachment_size, duration, thumbnail,
                   TO_CHAR(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as timestamp, status
            FROM messages 
            WHERE (sender_email = $1 AND receiver_email = $2) 
               OR (sender_email = $3 AND receiver_email = $4)
            ORDER BY timestamp ASC
        `, [userEmail, friendEmail, friendEmail, userEmail]);

        res.json({
            success: true,
            messages: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отправка текстового сообщения
app.post('/send-message', async (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, duration } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const result = await pool.query(
            `INSERT INTO messages (sender_email, receiver_email, message, duration) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [senderEmail.toLowerCase(), receiverEmail.toLowerCase(), message || '', duration || 0]
        );

        res.json({
            success: true,
            messageId: result.rows[0].id
        });

        // Автоматически добавляем в чаты если это новый диалог
        addToChatsAutomatically(senderEmail, receiverEmail);

    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла
app.post('/upload-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        const fileUrl = `/uploads/permanent/${req.file.filename}`;

        if (moveFileToPermanent(req.file.filename)) {
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
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const { senderEmail, receiverEmail, duration, message } = req.body;

        if (!senderEmail || !receiverEmail) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = duration || 0;

        const completeFileUpload = async (thumbnail = '') => {
            try {
                const result = await pool.query(
                    `INSERT INTO messages 
                     (sender_email, receiver_email, message, attachment_type, 
                      attachment_filename, attachment_original_name, attachment_mime_type, 
                      attachment_size, duration, thumbnail) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
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
                        thumbnail
                    ]
                );

                if (moveFileToPermanent(req.file.filename)) {
                    res.json({
                        success: true,
                        messageId: result.rows[0].id,
                        filename: req.file.filename,
                        thumbnail: thumbnail
                    });

                    addToChatsAutomatically(senderEmail, receiverEmail);
                } else {
                    throw new Error('Ошибка перемещения файла');
                }
            } catch (error) {
                fs.unlinkSync(req.file.path);
                if (thumbnail) {
                    fs.unlinkSync(path.join(thumbnailsDir, thumbnail));
                }
                throw error;
            }
        };

        if (fileType === 'image' || fileType === 'video') {
            const previewName = `preview_${path.parse(req.file.filename).name}.jpg`;
            const previewPath = path.join(thumbnailsDir, previewName);

            if (fileType === 'video') {
                getVideoDuration(req.file.path, (err, duration) => {
                    if (!err && duration > 0) videoDuration = duration;
                    
                    createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                        if (!err) thumbnailFilename = previewName;
                        completeFileUpload(thumbnailFilename);
                    });
                });
            } else {
                createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                    if (!err) thumbnailFilename = previewName;
                    completeFileUpload(thumbnailFilename);
                });
            }
        } else {
            await completeFileUpload();
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
app.post('/send-message-with-attachment', async (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, attachmentType, 
                attachmentFilename, attachmentOriginalName, attachmentUrl } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const result = await pool.query(
            `INSERT INTO messages 
             (sender_email, receiver_email, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                senderEmail.toLowerCase(),
                receiverEmail.toLowerCase(),
                message || '',
                attachmentType || '',
                attachmentFilename || '',
                attachmentOriginalName || '',
                attachmentUrl || ''
            ]
        );

        res.json({
            success: true,
            messageId: result.rows[0].id
        });

        addToChatsAutomatically(senderEmail, receiverEmail);

    } catch (error) {
        console.error('❌ Ошибка отправки сообщения с вложением:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Скачивание файла
app.get('/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const messageId = req.query.messageId;
        const userEmail = req.query.userEmail;
        const isSender = req.query.isSender === 'true';

        const filePath = path.join(permanentDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        if (messageId && userEmail) {
            await updateDownloadStatus(messageId, userEmail, isSender);
        }

        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        const originalName = req.query.originalName || filename;

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

    } catch (error) {
        console.error('❌ Ошибка скачивания файла:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о файле по ID сообщения
app.get('/file-info/:messageId', async (req, res) => {
    try {
        const messageId = req.params.messageId;

        const result = await pool.query(
            `SELECT attachment_filename, attachment_original_name, 
                    attachment_mime_type, attachment_size, attachment_type
             FROM messages WHERE id = $1`,
            [messageId]
        );

        if (result.rows.length === 0 || !result.rows[0].attachment_filename) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        const filePath = path.join(permanentDir, result.rows[0].attachment_filename);
        const exists = fs.existsSync(filePath);

        res.json({
            success: true,
            exists: exists,
            filename: result.rows[0].attachment_filename,
            originalName: result.rows[0].attachment_original_name,
            mimeType: result.rows[0].attachment_mime_type,
            size: result.rows[0].attachment_size,
            type: result.rows[0].attachment_type
        });
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Создание группы
app.post('/create-group', async (req, res) => {
    try {
        const { name, description, createdBy, members } = req.body;

        if (!name || !createdBy) {
            return res.status(400).json({ success: false, error: 'Название и создатель обязательны' });
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            const groupResult = await client.query(
                "INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id",
                [name, description || '', createdBy.toLowerCase()]
            );

            const groupId = groupResult.rows[0].id;

            await client.query(
                "INSERT INTO group_members (group_id, user_email, role) VALUES ($1, $2, 'admin')",
                [groupId, createdBy.toLowerCase()]
            );

            if (members && members.length > 0) {
                for (const member of members) {
                    if (member !== createdBy) {
                        await client.query(
                            "INSERT INTO group_members (group_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                            [groupId, member.toLowerCase()]
                        );
                    }
                }
            }

            await client.query('COMMIT');

            res.json({
                success: true,
                groupId: groupId,
                message: 'Группа создана'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Ошибка создания группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение списка групп пользователя
app.get('/groups/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const result = await pool.query(`
            SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                   gm.role, COUNT(gm2.user_email) as member_count
            FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            LEFT JOIN group_members gm2 ON g.id = gm2.group_id
            WHERE gm.user_email = $1
            GROUP BY g.id, g.name, g.description, g.created_by, g.created_at, gm.role
            ORDER BY g.name
        `, [userEmail]);

        res.json({
            success: true,
            groups: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения групп:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение участников группы
app.get('/group-members/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        const result = await pool.query(`
            SELECT u.email, u.first_name, u.last_name, gm.role, gm.joined_at
            FROM group_members gm
            JOIN users u ON gm.user_email = u.email
            WHERE gm.group_id = $1
            ORDER BY gm.role DESC, u.first_name, u.last_name
        `, [groupId]);

        res.json({
            success: true,
            members: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения участников группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Отправка сообщения в группу
app.post('/send-group-message', async (req, res) => {
    try {
        const { groupId, senderEmail, message, duration } = req.body;

        if (!groupId || !senderEmail) {
            return res.status(400).json({ success: false, error: 'Группа и отправитель обязательны' });
        }

        const result = await pool.query(
            `INSERT INTO group_messages (group_id, sender_email, message, duration) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [groupId, senderEmail.toLowerCase(), message || '', duration || 0]
        );

        res.json({
            success: true,
            messageId: result.rows[0].id
        });
    } catch (error) {
        console.error('❌ Ошибка отправки группового сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение сообщений группы
app.get('/group-messages/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        const result = await pool.query(`
            SELECT gm.id, gm.sender_email, gm.message, 
                   gm.attachment_type, gm.attachment_filename, gm.attachment_original_name,
                   gm.attachment_mime_type, gm.attachment_size, gm.duration, gm.thumbnail,
                   TO_CHAR(gm.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as timestamp,
                   u.first_name, u.last_name
            FROM group_messages gm
            JOIN users u ON gm.sender_email = u.email
            WHERE gm.group_id = $1
            ORDER BY gm.timestamp ASC
        `, [groupId]);

        res.json({
            success: true,
            messages: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения групповых сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление участника в группу
app.post('/add-group-member', async (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        await pool.query(
            "INSERT INTO group_members (group_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [groupId, userEmail.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'Участник добавлен'
        });
    } catch (error) {
        console.error('❌ Ошибка добавления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление участника из группы
app.post('/remove-group-member', async (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        await pool.query(
            "DELETE FROM group_members WHERE group_id = $1 AND user_email = $2",
            [groupId, userEmail.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'Участник удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление группы
app.delete('/group/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);

        res.json({
            success: true,
            message: 'Группа удалена'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Обновление статуса сообщения
app.post('/update-message-status', async (req, res) => {
    try {
        const { messageId, status } = req.body;

        if (!messageId || !status) {
            return res.status(400).json({ success: false, error: 'ID сообщения и статус обязательны' });
        }

        await pool.query(
            "UPDATE messages SET status = $1 WHERE id = $2",
            [status, messageId]
        );

        res.json({
            success: true,
            message: 'Статус обновлен'
        });
    } catch (error) {
        console.error('❌ Ошибка обновления статуса:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение непрочитанных сообщений
app.get('/unread-messages/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const result = await pool.query(`
            SELECT m.id, m.sender_email, m.receiver_email, m.message, 
                   m.attachment_type, m.attachment_filename, m.attachment_original_name,
                   TO_CHAR(m.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as timestamp,
                   u.first_name, u.last_name
            FROM messages m
            JOIN users u ON m.sender_email = u.email
            WHERE m.receiver_email = $1 AND m.status = 'sent'
            ORDER BY m.timestamp ASC
        `, [userEmail]);

        res.json({
            success: true,
            unreadMessages: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка получения непрочитанных сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Очистка истории чата
app.post('/clear-chat', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const result = await pool.query(
            `DELETE FROM messages 
             WHERE (sender_email = $1 AND receiver_email = $2) 
                OR (sender_email = $3 AND receiver_email = $4)`,
            [userEmail.toLowerCase(), friendEmail.toLowerCase(), 
             friendEmail.toLowerCase(), userEmail.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'История чата очищена',
            deletedCount: result.rowCount
        });
    } catch (error) {
        console.error('❌ Ошибка очистки чата:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Удаление аккаунта
app.delete('/delete-account/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const result = await pool.query("DELETE FROM users WHERE email = $1", [userEmail]);

        res.json({
            success: true,
            message: 'Аккаунт удален',
            deletedCount: result.rowCount
        });
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о пользователе
app.get('/user/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        const result = await pool.query(
            `SELECT email, first_name as "firstName", last_name as "lastName", 
             avatar_filename as "avatarFilename" FROM users WHERE email = $1`, 
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Обновление профиля
app.post('/update-profile', upload.single('avatar'), async (req, res) => {
    try {
        const { email, firstName, lastName, removeAvatar } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, error: 'Email обязателен' });
        }

        let avatarFilename = undefined;

        if (req.file) {
            if (moveFileToPermanent(req.file.filename)) {
                avatarFilename = req.file.filename;
            }
        } else if (removeAvatar === 'true') {
            avatarFilename = '';
        }

        let query = "UPDATE users SET first_name = $1, last_name = $2";
        let params = [firstName, lastName];

        if (avatarFilename !== undefined) {
            query += ", avatar_filename = $3";
            params.push(avatarFilename);
        }

        query += " WHERE email = $" + (params.length + 1);
        params.push(email.toLowerCase());

        await pool.query(query, params);

        const result = await pool.query(
            `SELECT email, first_name as "firstName", last_name as "lastName", 
                    avatar_filename as "avatarFilename" FROM users WHERE email = $1`, 
            [email.toLowerCase()]
        );

        res.json({
            success: true,
            message: 'Профиль обновлен',
            user: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Agora токен
app.get('/agora/token/:channelName/:userId', (req, res) => {
    try {
        const { channelName, userId } = req.params;

        if (!channelName) {
            return res.status(400).json({ success: false, error: 'Channel name обязателен' });
        }

        if (!isValidChannelName(channelName)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Недопустимое имя канала' 
            });
        }

        const appId = process.env.AGORA_APP_ID || '0eef2fbc530f4d27a19a18f6527dda20';
        const appCertificate = process.env.AGORA_APP_CERTIFICATE || '5ffaa1348ef5433b8fbb37d22772ca0e';
        const expirationTimeInSeconds = 3600;

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

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

// Создание Agora звонка
app.post('/agora/create-call', async (req, res) => {
    try {
        const { callerEmail, receiverEmail, callType, channelName } = req.body;

        if (!callerEmail || !receiverEmail || !channelName) {
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        if (!isValidChannelName(channelName)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Недопустимое имя канала' 
            });
        }

        const result = await pool.query(
            `INSERT INTO agora_calls (channel_name, caller_email, receiver_email, call_type, status)
             VALUES ($1, $2, $3, $4, 'ringing') RETURNING *`,
            [channelName, callerEmail.toLowerCase(), receiverEmail.toLowerCase(), callType || 'audio']
        );

        res.json({
            success: true,
            callId: result.rows[0].id,
            channelName: channelName
        });

    } catch (error) {
        console.error('❌ Ошибка создания Agora звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Завершение Agora звонка
app.post('/agora/end-call', async (req, res) => {
    try {
        const { channelName } = req.body;

        if (!channelName) {
            return res.status(400).json({ success: false, error: 'Channel name обязателен' });
        }

        await pool.query(
            "UPDATE agora_calls SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE channel_name = $1",
            [channelName]
        );

        res.json({
            success: true,
            message: 'Звонок завершен'
        });

    } catch (error) {
        console.error('❌ Ошибка завершения Agora звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение активных Agora звонков
app.get('/agora/active-calls/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const result = await pool.query(`
            SELECT channel_name as "channelName", caller_email as "callerEmail", 
                   receiver_email as "receiverEmail", call_type as "callType", 
                   status, created_at as "createdAt"
            FROM agora_calls 
            WHERE (caller_email = $1 OR receiver_email = $1) 
            AND status = 'ringing'
            ORDER BY created_at DESC
        `, [userEmail]);

        res.json({
            success: true,
            calls: result.rows
        });

    } catch (error) {
        console.error('❌ Ошибка получения активных Agora звонков:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ОБНОВЛЕННЫЙ ЭНДПОИНТ ДЛЯ УВЕДОМЛЕНИЙ О ЗВОНКАХ
app.post('/send-call-notification', async (req, res) => {
  try {
    const { channelName, receiverEmail, callType, callerEmail, callerName } = req.body;

    console.log(`📞 Отправка уведомления о звонке:`, {
      caller: callerEmail,
      receiver: receiverEmail,
      channel: channelName,
      type: callType
    });

    if (!channelName || !receiverEmail || !callerEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'channelName, receiverEmail, callerEmail обязательны' 
      });
    }

    // 1. Сохраняем информацию о звонке в базу
    let callId;
    try {
      const callResult = await pool.query(
        `INSERT INTO agora_calls (channel_name, caller_email, receiver_email, call_type, status)
         VALUES ($1, $2, $3, $4, 'ringing') RETURNING id`,
        [channelName, callerEmail.toLowerCase(), receiverEmail.toLowerCase(), callType || 'audio']
      );
      callId = callResult.rows[0].id;
    } catch (dbError) {
      console.error('❌ Ошибка сохранения звонка в БД:', dbError);
    }

    // 2. WebSocket уведомление (если пользователь онлайн)
    const receiverSocketId = activeUsers.get(receiverEmail.toLowerCase());
    const websocketDelivered = !!(receiverSocketId && io.sockets.sockets.has(receiverSocketId));
    
    if (websocketDelivered) {
      io.to(receiverSocketId).emit('AGORA_INCOMING_CALL', {
        channelName,
        callerEmail,
        callerName: callerName || callerEmail,
        callType: callType || 'audio',
        callId: callId,
        timestamp: new Date().toISOString()
      });
      console.log(`✅ WebSocket уведомление отправлено: ${receiverEmail}`);
    }

    // 3. Push уведомление (даже если пользователь оффлайн)
    const displayName = callerName || callerEmail.split('@')[0];
    const pushSent = await sendPushNotification(
      receiverEmail,
      '📞 Входящий звонок',
      `${displayName} вызывает вас`,
      {
        type: 'incoming_call',
        channelName: channelName,
        callerEmail: callerEmail,
        callerName: displayName,
        callType: callType || 'audio',
        callId: callId,
        timestamp: new Date().toISOString()
      }
    );

    res.json({ 
      success: true, 
      message: 'Уведомления отправлены',
      details: {
        callId: callId,
        websocketDelivered: websocketDelivered,
        pushDelivered: pushSent,
        channelName: channelName
      }
    });

  } catch (error) {
    console.error('❌ Ошибка отправки уведомлений о звонке:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// ОТМЕНА УВЕДОМЛЕНИЯ О ЗВОНКЕ
app.post('/cancel-call-notification', async (req, res) => {
  try {
    const { channelName, callerEmail, receiverEmail } = req.body;

    console.log(`❌ Отмена уведомления о звонке: ${channelName}`);

    // 1. Обновляем статус звонка в БД
    await pool.query(
      "UPDATE agora_calls SET status = 'canceled', ended_at = CURRENT_TIMESTAMP WHERE channel_name = $1",
      [channelName]
    );

    // 2. WebSocket уведомление об отмене
    const receiverSocketId = activeUsers.get(receiverEmail.toLowerCase());
    if (receiverSocketId && io.sockets.sockets.has(receiverSocketId)) {
      io.to(receiverSocketId).emit('AGORA_CALL_CANCELED', {
        channelName,
        callerEmail,
        timestamp: new Date().toISOString()
      });
    }

    // 3. Push уведомление об отмене (опционально)
    await sendPushNotification(
      receiverEmail,
      '❌ Звонок отменен',
      `${callerEmail} отменил звонок`,
      {
        type: 'call_canceled',
        channelName: channelName,
        callerEmail: callerEmail,
        timestamp: new Date().toISOString()
      }
    );

    res.json({ 
      success: true, 
      message: 'Уведомление о звонке отменено' 
    });

  } catch (error) {
    console.error('❌ Ошибка отмены уведомления:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ЭНДПОИНТ ДЛЯ СОХРАНЕНИЯ FCM ТОКЕНА
app.post('/save-fcm-token', async (req, res) => {
  try {
    const { userEmail, fcmToken, platform = 'android' } = req.body;

    if (!userEmail || !fcmToken) {
      return res.status(400).json({ success: false, error: 'Email и токен обязательны' });
    }

    await pool.query(
      `INSERT INTO fcm_tokens (user_email, fcm_token, platform, updated_at) 
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
       ON CONFLICT (user_email, fcm_token) 
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
      [userEmail.toLowerCase(), fcmToken, platform]
    );

    res.json({ success: true, message: 'FCM токен сохранен' });
  } catch (error) {
    console.error('❌ Ошибка сохранения FCM токена:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// УЛУЧШЕННАЯ ФУНКЦИЯ ОТПРАВКИ PUSH-УВЕДОМЛЕНИЙ О ЗВОНКАХ
async function sendPushNotification(userEmail, title, body, data = {}) {
  try {
    console.log(`📱 Попытка отправки push-уведомления для: ${userEmail}`);
    
    // Ищем актуальные FCM токены пользователя
    const result = await pool.query(
      `SELECT fcm_token, platform FROM fcm_tokens 
       WHERE user_email = $1 
       AND updated_at > NOW() - INTERVAL '30 days'
       ORDER BY updated_at DESC
       LIMIT 5`,
      [userEmail.toLowerCase()]
    );

    if (result.rows.length === 0) {
      console.log(`❌ Активных FCM токенов не найдено для: ${userEmail}`);
      return false;
    }

    console.log(`✅ Найдено токенов: ${result.rows.length} для ${userEmail}`);

    let successCount = 0;

    // Отправляем уведомления на все активные токены пользователя
    for (const tokenRow of result.rows) {
      try {
        const message = {
          token: tokenRow.fcm_token,
          notification: {
            title: title,
            body: body
          },
          data: {
            ...data,
            notification_foreground: 'true', // Для обработки в foreground
            click_action: 'INCOMING_CALL_ACTION'
          },
          android: {
            priority: 'high',
            ttl: 60 * 1000, // 60 секунд
            notification: {
              sound: 'default',
              channelId: 'calls_channel',
              vibrateTimingsMillis: [0, 500, 250, 500],
              priority: 'max',
              visibility: 'public',
              defaultSound: true,
              lightSettings: {
                color: '#FF0000',
                lightOnDurationMillis: 1000,
                lightOffDurationMillis: 1000
              }
            }
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
                category: 'INCOMING_CALL',
                'mutable-content': 1
              }
            }
          }
        };

        console.log(`📤 Отправка на токен: ${tokenRow.fcm_token.substring(0, 20)}...`);
        
        const response = await admin.messaging().send(message);
        console.log(`✅ Push-уведомление отправлено успешно: ${response}`);
        successCount++;
        
      } catch (tokenError) {
        console.error(`❌ Ошибка отправки на токен:`, tokenError.message);
        
        // Если токен невалидный, удаляем его из БД
        if (tokenError.code === 'messaging/invalid-registration-token' || 
            tokenError.code === 'messaging/registration-token-not-registered') {
          await pool.query(
            'DELETE FROM fcm_tokens WHERE fcm_token = $1',
            [tokenRow.fcm_token]
          );
          console.log(`🗑️  Невалидный токен удален: ${tokenRow.fcm_token.substring(0, 20)}...`);
        }
      }
    }

    console.log(`📊 Итог: успешно отправлено ${successCount} из ${result.rows.length} уведомлений`);
    return successCount > 0;

  } catch (error) {
    console.error('❌ Критическая ошибка отправки push-уведомления:', error);
    return false;
  }
}

// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О FCM ТОКЕНАХ ПОЛЬЗОВАТЕЛЯ
app.get('/fcm-tokens/:userEmail', async (req, res) => {
  try {
    const userEmail = req.params.userEmail.toLowerCase();

    const result = await pool.query(
      `SELECT fcm_token, platform, created_at, updated_at 
       FROM fcm_tokens 
       WHERE user_email = $1 
       ORDER BY updated_at DESC`,
      [userEmail]
    );

    res.json({
      success: true,
      tokens: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('❌ Ошибка получения FCM токенов:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ЭНДПОИНТ ДЛЯ УДАЛЕНИЯ FCM ТОКЕНА (при выходе)
app.post('/remove-fcm-token', async (req, res) => {
  try {
    const { userEmail, fcmToken } = req.body;

    await pool.query(
      'DELETE FROM fcm_tokens WHERE user_email = $1 AND fcm_token = $2',
      [userEmail.toLowerCase(), fcmToken]
    );

    res.json({ success: true, message: 'FCM токен удален' });
  } catch (error) {
    console.error('❌ Ошибка удаления FCM токена:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// WebSocket соединения
io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);

  socket.on('user_online', (data) => {
    activeUsers.set(data.email, socket.id);
    console.log(`👤 Пользователь онлайн: ${data.email}`);
  });

  socket.on('call_notification', (data) => {
    const receiverSocketId = activeUsers.get(data.receiverEmail);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('AGORA_INCOMING_CALL', {
        channelName: data.channelName,
        callerEmail: data.callerEmail,
        callType: data.callType
      });
      console.log(`📞 Уведомление о звонке отправлено: ${data.channelName} -> ${data.receiverEmail}`);
    }
  });

  socket.on('end_call', (data) => {
    const receiverSocketId = activeUsers.get(data.receiverEmail);
    if (receiverSocketId) {
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

// Статические файлы
app.use('/uploads', express.static(uploadDir));

// Запуск сервера
server.listen(PORT, async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📡 WebSocket сервер активен`);
    
    // Создаем таблицы при запуске
    await createTables();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    await pool.end();
    console.log('✅ Подключение к БД закрыто');
    process.exit(0);
});

module.exports = app;
