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
const isRender = process.env.NODE_ENV === 'production';
const pendingCalls = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: isRender ? ["https://beresta-server.onrender.com", "https://your-client-domain.com"] : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
  maxHttpBufferSize: 1e8,
  connectTimeout: 45000
});

// PostgreSQL подключение
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));

// Настройка загрузки файлов
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const tempDir = path.join(uploadDir, 'temp');
const permanentDir = path.join(uploadDir, 'permanent');
const thumbnailsDir = path.join(uploadDir, 'thumbnails');

[uploadDir, tempDir, permanentDir, thumbnailsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 Создана папка:', dir);
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

// Устанавливаем пути к ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Функции для работы с пользователями
async function getUserTableAndType(email) {
  const normalizedEmail = email.toLowerCase();
  
  const berestaResult = await pool.query(
    "SELECT 'beresta' as user_type FROM beresta_users WHERE email = $1",
    [normalizedEmail]
  );
  
  if (berestaResult.rows.length > 0) {
    return { table: 'beresta_users', type: 'beresta' };
  }
  
  const regularResult = await pool.query(
    "SELECT 'regular' as user_type FROM regular_users WHERE email = $1",
    [normalizedEmail]
  );
  
  if (regularResult.rows.length > 0) {
    return { table: 'regular_users', type: 'regular' };
  }
  
  return null;
}

async function userExists(email) {
  const userInfo = await getUserTableAndType(email);
  return userInfo !== null;
}

// Функция для создания таблиц
async function createTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Создание/проверка таблиц...');

    const queries = [
      // ОБЫЧНЫЕ ПОЛЬЗОВАТЕЛИ
      `CREATE TABLE IF NOT EXISTS regular_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // BERESTA ID ПОЛЬЗОВАТЕЛИ
      `CREATE TABLE IF NOT EXISTS beresta_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        avatar_filename TEXT DEFAULT '',
        beresta_id TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // ОБЩИЕ ТАБЛИЦЫ
      `CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        friend_email TEXT NOT NULL,
        user_type TEXT DEFAULT 'regular',
        friend_type TEXT DEFAULT 'regular',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, friend_email)
      )`,

      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_email TEXT NOT NULL,
        sender_type TEXT DEFAULT 'regular',
        receiver_email TEXT NOT NULL,
        receiver_type TEXT DEFAULT 'regular',
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
        created_by_type TEXT DEFAULT 'regular',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        user_type TEXT DEFAULT 'regular',
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_email)
      )`,

      `CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        sender_email TEXT NOT NULL,
        sender_type TEXT DEFAULT 'regular',
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

      `CREATE TABLE IF NOT EXISTS agora_calls (
        id SERIAL PRIMARY KEY,
        channel_name TEXT UNIQUE NOT NULL,
        caller_email TEXT NOT NULL,
        caller_type TEXT DEFAULT 'regular',
        receiver_email TEXT NOT NULL,
        receiver_type TEXT DEFAULT 'regular',
        call_type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      )`,

      // Индексы
      `CREATE INDEX IF NOT EXISTS idx_regular_users_email ON regular_users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_beresta_users_email ON beresta_users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_email, receiver_email)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)`
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

// Функция автоматического добавления в чаты
async function addToChatsAutomatically(user1, user2) {
    try {
        const user1Info = await getUserTableAndType(user1);
        const user2Info = await getUserTableAndType(user2);

        if (!user1Info || !user2Info) {
            console.log('⚠️  Один или оба пользователя не найдены');
            return;
        }

        await pool.query(
            `INSERT INTO friends (user_email, friend_email, user_type, friend_type) 
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [user1.toLowerCase(), user2.toLowerCase(), user1Info.type, user2Info.type]
        );

        await pool.query(
            `INSERT INTO friends (user_email, friend_email, user_type, friend_type) 
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [user2.toLowerCase(), user1.toLowerCase(), user2Info.type, user1Info.type]
        );

        console.log(`✅ Автоматически добавлены чаты: ${user1} (${user1Info.type}) ↔️ ${user2} (${user2Info.type})`);
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

// Регистрация обычного пользователя
app.post('/register', async (req, res) => {
    try {
        const { email, firstName, lastName } = req.body;

        if (!email || !firstName || !lastName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Все поля обязательны' 
            });
        }

        const existingUser = await userExists(email);
        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                error: 'Пользователь уже существует' 
            });
        }

        const result = await pool.query(
            "INSERT INTO regular_users (email, first_name, last_name) VALUES ($1, $2, $3) RETURNING *",
            [email.toLowerCase(), firstName, lastName]
        );

        res.json({
            success: true,
            message: 'Пользователь успешно зарегистрирован',
            userId: result.rows[0].id,
            userType: 'regular'
        });

    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Регистрация Beresta ID пользователя
app.post('/register-beresta', async (req, res) => {
    try {
        const { email, firstName, lastName, berestaId } = req.body;

        if (!email || !firstName || !lastName || !berestaId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Все поля обязательны' 
            });
        }

        const existingUser = await userExists(email);
        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                error: 'Пользователь уже существует' 
            });
        }

        const result = await pool.query(
            "INSERT INTO beresta_users (email, first_name, last_name, beresta_id) VALUES ($1, $2, $3, $4) RETURNING *",
            [email.toLowerCase(), firstName, lastName, berestaId]
        );

        res.json({
            success: true,
            message: 'Beresta ID пользователь зарегистрирован',
            userId: result.rows[0].id,
            userType: 'beresta'
        });

    } catch (error) {
        console.error('❌ Ошибка регистрации Beresta ID:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение всех пользователей
app.get('/users', async (req, res) => {
    try {
        const regularResult = await pool.query(
            "SELECT email, first_name as \"firstName\", last_name as \"lastName\", 'regular' as \"userType\" FROM regular_users ORDER BY first_name, last_name"
        );

        const berestaResult = await pool.query(
            "SELECT email, first_name as \"firstName\", last_name as \"lastName\", 'beresta' as \"userType\" FROM beresta_users ORDER BY first_name, last_name"
        );

        const allUsers = [...regularResult.rows, ...berestaResult.rows];

        res.json({
            success: true,
            users: allUsers
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователей:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение информации о пользователе
app.get('/user/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email).toLowerCase();

        const regularResult = await pool.query(
            `SELECT email, first_name as "firstName", last_name as "lastName", 
             avatar_filename as "avatarFilename", 'regular' as "userType" 
             FROM regular_users WHERE email = $1`, 
            [email]
        );

        if (regularResult.rows.length > 0) {
            return res.json({
                success: true,
                user: regularResult.rows[0]
            });
        }

        const berestaResult = await pool.query(
            `SELECT email, first_name as "firstName", last_name as "lastName", 
             avatar_filename as "avatarFilename", 'beresta' as "userType",
             beresta_id as "berestaId"
             FROM beresta_users WHERE email = $1`, 
            [email]
        );

        if (berestaResult.rows.length > 0) {
            return res.json({
                success: true,
                user: berestaResult.rows[0]
            });
        }

        return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
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

        const userInfo = await getUserTableAndType(userEmail);
        const friendInfo = await getUserTableAndType(friendEmail);

        if (!userInfo || !friendInfo) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователи не найдены' 
            });
        }

        await pool.query(
            `INSERT INTO friends (user_email, friend_email, user_type, friend_type) 
             VALUES ($1, $2, $3, $4) ON CONFLICT (user_email, friend_email) DO NOTHING`,
            [userEmail.toLowerCase(), friendEmail.toLowerCase(), userInfo.type, friendInfo.type]
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
            LEFT JOIN regular_users u ON u.email = f.friend_email AND f.friend_type = 'regular'
            LEFT JOIN beresta_users u2 ON u2.email = f.friend_email AND f.friend_type = 'beresta'
            LEFT JOIN messages m ON 
                (m.sender_email = f.user_email AND m.receiver_email = f.friend_email) OR
                (m.sender_email = f.friend_email AND m.receiver_email = f.user_email)
            WHERE f.user_email = $1
            GROUP BY u.email, u.first_name, u.last_name, u2.email, u2.first_name, u2.last_name
            
            UNION
            
            SELECT 
                CASE 
                    WHEN m.sender_email = $2 THEN m.receiver_email
                    ELSE m.sender_email
                END as "contactEmail",
                COALESCE(ru.first_name, bu.first_name) as "firstName",
                COALESCE(ru.last_name, bu.last_name) as "lastName",
                'chat' as type,
                MAX(m.timestamp) as "lastMessageTime"
            FROM messages m
            LEFT JOIN regular_users ru ON ru.email = CASE 
                WHEN m.sender_email = $2 THEN m.receiver_email
                ELSE m.sender_email
            END
            LEFT JOIN beresta_users bu ON bu.email = CASE 
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
            GROUP BY "contactEmail", ru.first_name, ru.last_name, bu.first_name, bu.last_name
            
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

        const senderInfo = await getUserTableAndType(senderEmail);
        const receiverInfo = await getUserTableAndType(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const result = await pool.query(
            `INSERT INTO messages (sender_email, receiver_email, sender_type, receiver_type, message, duration) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                senderEmail.toLowerCase(), 
                receiverEmail.toLowerCase(),
                senderInfo.type,
                receiverInfo.type,
                message || '', 
                duration || 0
            ]
        );

        res.json({
            success: true,
            messageId: result.rows[0].id
        });

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

        const senderInfo = await getUserTableAndType(senderEmail);
        const receiverInfo = await getUserTableAndType(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = duration || 0;

        const completeFileUpload = async (thumbnail = '') => {
            try {
                const result = await pool.query(
                    `INSERT INTO messages 
                     (sender_email, receiver_email, sender_type, receiver_type, message, attachment_type, 
                      attachment_filename, attachment_original_name, attachment_mime_type, 
                      attachment_size, duration, thumbnail) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                    [
                        senderEmail.toLowerCase(),
                        receiverEmail.toLowerCase(),
                        senderInfo.type,
                        receiverInfo.type,
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

        const senderInfo = await getUserTableAndType(senderEmail);
        const receiverInfo = await getUserTableAndType(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const result = await pool.query(
            `INSERT INTO messages 
             (sender_email, receiver_email, sender_type, receiver_type, message, attachment_type, 
              attachment_filename, attachment_original_name, attachment_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                senderEmail.toLowerCase(),
                receiverEmail.toLowerCase(),
                senderInfo.type,
                receiverInfo.type,
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

        const createdByInfo = await getUserTableAndType(createdBy);
        if (!createdByInfo) {
            return res.status(404).json({ success: false, error: 'Создатель не найден' });
        }

        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            const groupResult = await client.query(
                "INSERT INTO groups (name, description, created_by, created_by_type) VALUES ($1, $2, $3, $4) RETURNING id",
                [name, description || '', createdBy.toLowerCase(), createdByInfo.type]
            );

            const groupId = groupResult.rows[0].id;

            await client.query(
                "INSERT INTO group_members (group_id, user_email, user_type, role) VALUES ($1, $2, $3, 'admin')",
                [groupId, createdBy.toLowerCase(), createdByInfo.type]
            );

            if (members && members.length > 0) {
                for (const member of members) {
                    if (member !== createdBy) {
                        const memberInfo = await getUserTableAndType(member);
                        if (memberInfo) {
                            await client.query(
                                "INSERT INTO group_members (group_id, user_email, user_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                                [groupId, member.toLowerCase(), memberInfo.type]
                            );
                        }
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
            LEFT JOIN regular_users u ON gm.user_email = u.email AND gm.user_type = 'regular'
            LEFT JOIN beresta_users u2 ON gm.user_email = u2.email AND gm.user_type = 'beresta'
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

        const senderInfo = await getUserTableAndType(senderEmail);
        if (!senderInfo) {
            return res.status(404).json({ success: false, error: 'Отправитель не найден' });
        }

        const result = await pool.query(
            `INSERT INTO group_messages (group_id, sender_email, sender_type, message, duration) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [groupId, senderEmail.toLowerCase(), senderInfo.type, message || '', duration || 0]
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
                   COALESCE(ru.first_name, bu.first_name) as first_name,
                   COALESCE(ru.last_name, bu.last_name) as last_name
            FROM group_messages gm
            LEFT JOIN regular_users ru ON gm.sender_email = ru.email AND gm.sender_type = 'regular'
            LEFT JOIN beresta_users bu ON gm.sender_email = bu.email AND gm.sender_type = 'beresta'
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

// Обновление профиля
app.post('/update-profile', upload.single('avatar'), async (req, res) => {
    try {
        const { email, firstName, lastName, removeAvatar } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, error: 'Email обязателен' });
        }

        const userInfo = await getUserTableAndType(email);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        let avatarFilename = undefined;

        if (req.file) {
            if (moveFileToPermanent(req.file.filename)) {
                avatarFilename = req.file.filename;
            }
        } else if (removeAvatar === 'true') {
            avatarFilename = '';
        }

        let query = `UPDATE ${userInfo.table} SET first_name = $1, last_name = $2`;
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
                    avatar_filename as "avatarFilename", '${userInfo.type}' as "userType" 
             FROM ${userInfo.table} WHERE email = $1`, 
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

        console.log(`🔑 Запрос токена: channel=${channelName}, userId=${userId}`);

        if (!channelName) {
            console.log('❌ Пустое имя канала');
            return res.status(400).json({ success: false, error: 'Channel name обязателен' });
        }

        if (!isValidChannelName(channelName)) {
            console.log(`❌ Недопустимое имя канала: ${channelName}`);
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
        
        console.log(`🛠️ Генерация токена: appId=${appId}, uid=${uid}, channel=${channelName}`);
        
        const token = Agora.RtcTokenBuilder.buildTokenWithUid(
            appId,
            appCertificate,
            channelName,
            uid,
            Agora.RtcRole.PUBLISHER,
            privilegeExpiredTs
        );

        console.log(`✅ Токен сгенерирован успешно для канала: ${channelName}`);

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
        console.log('📞 Данные создания звонка:', req.body);
        
        const { callerEmail, receiverEmail, callType, channelName } = req.body;

        if (!callerEmail || !receiverEmail || !channelName) {
            console.log('❌ Отсутствуют обязательные поля');
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        const callerInfo = await getUserTableAndType(callerEmail);
        const receiverInfo = await getUserTableAndType(receiverEmail);

        if (!callerInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        if (!isValidChannelName(channelName)) {
            console.log('❌ Невалидное имя канала:', channelName);
            return res.status(400).json({ 
                success: false, 
                error: 'Недопустимое имя канала' 
            });
        }

        const result = await pool.query(
            `INSERT INTO agora_calls (channel_name, caller_email, caller_type, receiver_email, receiver_type, call_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'ringing') RETURNING *`,
            [channelName, callerEmail.toLowerCase(), callerInfo.type, receiverEmail.toLowerCase(), receiverInfo.type, callType || 'audio']
        );

        console.log('✅ Запись звонка создана:', result.rows[0]);
        
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

// WebSocket соединения
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ WebSocket подключение установлено:', socket.id);
  
  if (socket.userEmail) {
    activeUsers.set(socket.userEmail, socket.id);
    
    console.log(`👤 Пользователь онлайн: ${socket.userEmail} (socket: ${socket.id})`);
    console.log(`📊 Всего онлайн: ${activeUsers.size} пользователей`);

    socket.emit('connection_established', {
      status: 'connected',
      email: socket.userEmail,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });

    socket.broadcast.emit('user_status_changed', {
      email: socket.userEmail,
      status: 'online',
      timestamp: new Date().toISOString()
    });
  }

  socket.on('ping', (data) => {
    socket.emit('pong', {
      ...data,
      serverTime: new Date().toISOString()
    });
  });

  socket.on('user_online', (data) => {
    try {
      if (data && data.email) {
        const email = data.email.toLowerCase();
        activeUsers.set(email, socket.id);
        socket.userEmail = email;
        
        console.log(`👤 Явный user_online: ${email}`);
        
        socket.emit('user_online_confirmed', {
          status: 'confirmed',
          email: email,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('❌ Ошибка в user_online:', error);
    }
  });

  socket.on('call_notification', (data) => {
    try {
      console.log('📞 Получен call_notification:', data);
      
      if (!data || !data.receiverEmail) {
        socket.emit('call_notification_failed', {
          error: 'No receiver email'
        });
        return;
      }

      const receiverEmail = data.receiverEmail.toLowerCase();
      const receiverSocketId = activeUsers.get(receiverEmail);
      
      console.log(`🔍 Поиск получателя: ${receiverEmail} -> ${receiverSocketId}`);

      if (receiverSocketId && io.sockets.sockets.has(receiverSocketId)) {
        const callData = {
          type: 'incoming_call',
          channelName: data.channelName,
          callerEmail: data.callerEmail,
          callerName: data.callerName || data.callerEmail,
          callType: data.callType || 'audio',
          timestamp: new Date().toISOString(),
          callId: data.callId || Date.now().toString()
        };

        io.to(receiverSocketId).emit('incoming_call', callData);
        
        console.log(`✅ Уведомление отправлено: ${receiverEmail}`);
        
        socket.emit('call_notification_sent', {
          success: true,
          receiver: receiverEmail,
          timestamp: new Date().toISOString()
        });
      } else {
        console.log(`❌ Пользователь оффлайн: ${receiverEmail}`);
        
        socket.emit('call_notification_failed', {
          success: false,
          error: 'USER_OFFLINE',
          receiver: receiverEmail
        });
      }
    } catch (error) {
      console.error('❌ Ошибка в call_notification:', error);
      socket.emit('call_notification_failed', {
        error: 'INTERNAL_ERROR',
        details: error.message
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`❌ WebSocket отключен: ${socket.id}, причина: ${reason}`);
    
    if (socket.userEmail) {
      activeUsers.delete(socket.userEmail);
      console.log(`👤 Удален из онлайн: ${socket.userEmail}`);
      
      socket.broadcast.emit('user_status_changed', {
        email: socket.userEmail,
        status: 'offline',
        timestamp: new Date().toISOString(),
        reason: reason
      });
    }
    
    console.log(`📊 Осталось онлайн: ${activeUsers.size} пользователей`);
  });

  socket.on('error', (error) => {
    console.error('💥 WebSocket ошибка:', error);
  });
});

// Эндпоинты для звонков
app.post('/send-call', async (req, res) => {
    try {
        const { channelName, callerEmail, receiverEmail, callType, callerName } = req.body;

        console.log('📞 Отправка звонка:', { channelName, callerEmail, receiverEmail, callType });

        if (!channelName || !callerEmail || !receiverEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'channelName, callerEmail, receiverEmail обязательны' 
            });
        }

        const callerInfo = await getUserTableAndType(callerEmail);
        const receiverInfo = await getUserTableAndType(receiverEmail);

        if (!callerInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const normalizedReceiver = receiverEmail.toLowerCase();
        
        const callData = {
            channelName: channelName,
            callerEmail: callerEmail,
            receiverEmail: normalizedReceiver,
            callType: callType || 'audio',
            callerName: callerName || callerEmail,
            timestamp: new Date().toISOString(),
            callId: Date.now().toString()
        };

        await pool.query(
            `INSERT INTO agora_calls (channel_name, caller_email, caller_type, receiver_email, receiver_type, call_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'ringing') 
             ON CONFLICT (channel_name) 
             DO UPDATE SET status = 'ringing', created_at = CURRENT_TIMESTAMP`,
            [channelName, callerEmail, callerInfo.type, normalizedReceiver, receiverInfo.type, callType || 'audio']
        );

        pendingCalls.set(normalizedReceiver, callData);
        
        setTimeout(() => {
            if (pendingCalls.get(normalizedReceiver)?.callId === callData.callId) {
                pendingCalls.delete(normalizedReceiver);
                console.log(`🗑️  Очищен ожидающий звонок для: ${normalizedReceiver}`);
            }
        }, 60000);

        console.log(`✅ Звонок отправлен: ${callerEmail} -> ${normalizedReceiver}`);

        res.json({
            success: true,
            message: 'Call sent successfully',
            callId: callData.callId
        });

    } catch (error) {
        console.error('❌ Ошибка отправки звонка:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// Проверка входящих звонков
app.get('/check-incoming-calls/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        const timeout = parseInt(req.query.timeout) || 30000;

        console.log(`🔍 Проверка звонков для: ${userEmail}, timeout: ${timeout}ms`);

        const existingCall = pendingCalls.get(userEmail);
        if (existingCall) {
            pendingCalls.delete(userEmail);
            return res.json({
                success: true,
                hasCall: true,
                call: existingCall
            });
        }

        const checkCall = () => {
            const call = pendingCalls.get(userEmail);
            if (call) {
                pendingCalls.delete(userEmail);
                res.json({
                    success: true,
                    hasCall: true,
                    call: call
                });
                return true;
            }
            return false;
        };

        if (checkCall()) return;

        const interval = setInterval(() => {
            if (checkCall()) {
                clearInterval(interval);
            }
        }, 1000);

        setTimeout(() => {
            clearInterval(interval);
            if (!res.headersSent) {
                res.json({
                    success: true,
                    hasCall: false,
                    message: 'No incoming calls'
                });
            }
        }, timeout);

    } catch (error) {
        console.error('❌ Ошибка проверки звонков:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                error: 'Internal server error' 
            });
        }
    }
});

// Завершение звонка
app.post('/end-call', async (req, res) => {
    try {
        const { channelName, receiverEmail } = req.body;

        if (!channelName) {
            return res.status(400).json({ 
                success: false, 
                error: 'channelName обязателен' 
            });
        }

        if (receiverEmail) {
            pendingCalls.delete(receiverEmail.toLowerCase());
        }

        await pool.query(
            "UPDATE agora_calls SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE channel_name = $1",
            [channelName]
        );

        res.json({
            success: true,
            message: 'Call ended'
        });

    } catch (error) {
        console.error('❌ Ошибка завершения звонка:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
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

        const userInfo = await getUserTableAndType(userEmail);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const result = await pool.query(`DELETE FROM ${userInfo.table} WHERE email = $1`, [userEmail]);

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

// ДОБАВЬТЕ ПОСЛЕ СУЩЕСТВУЮЩИХ ENDPOINTS:

// Загрузка файла в группу
app.post('/upload-group', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const { groupId, senderEmail, message } = req.body;

        if (!groupId || !senderEmail) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Группа и отправитель обязательны' });
        }

        const senderInfo = await getUserTableAndType(senderEmail);
        if (!senderInfo) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, error: 'Отправитель не найден' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = 0;

        const completeFileUpload = async (thumbnail = '') => {
            try {
                const result = await pool.query(
                    `INSERT INTO group_messages 
                     (group_id, sender_email, sender_type, message, attachment_type, 
                      attachment_filename, attachment_original_name, attachment_mime_type, 
                      attachment_size, duration, thumbnail) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                    [
                        groupId,
                        senderEmail.toLowerCase(),
                        senderInfo.type,
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
        console.error('❌ Ошибка загрузки группового файла:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Информация о групповом файле
app.get('/group-file-info/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;

        const result = await pool.query(
            `SELECT attachment_filename, attachment_original_name, 
                    attachment_mime_type, attachment_size, attachment_type
             FROM group_messages WHERE attachment_filename = $1`,
            [filename]
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
        console.error('❌ Ошибка получения информации о групповом файле:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Проверка активных звонков
app.get('/check-calls/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        
        console.log(`🔍 Проверка звонков для: ${userEmail}`);
        
        const result = await pool.query(`
            SELECT channel_name as "channelName", caller_email as "callerEmail", 
                   receiver_email as "receiverEmail", call_type as "callType", 
                   status, created_at as "createdAt"
            FROM agora_calls 
            WHERE receiver_email = $1 
            AND status = 'ringing'
            AND created_at > NOW() - INTERVAL '5 minutes'
            ORDER BY created_at DESC
            LIMIT 5
        `, [userEmail]);

        console.log(`📞 Найдено активных звонков: ${result.rows.length}`);
        
        res.json({
            success: true,
            calls: result.rows,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Ошибка проверки звонков:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Добавление участника в группу
app.post('/add-group-member', async (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        const userInfo = await getUserTableAndType(userEmail);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        await pool.query(
            "INSERT INTO group_members (group_id, user_email, user_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [groupId, userEmail.toLowerCase(), userInfo.type]
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

// Статические файлы
app.use('/uploads', express.static(uploadDir));

// Запуск сервера
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🌐 URL: http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket сервер активен: ws://0.0.0.0:${PORT}`);
    console.log(`🔧 Режим: ${process.env.NODE_ENV || 'development'}`);
    
    await createTables();
    
    console.log('✅ Сервер готов к работе');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    await pool.end();
    console.log('✅ Подключение к БД закрыто');
    process.exit(0);
});
