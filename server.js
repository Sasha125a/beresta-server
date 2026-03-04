const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const Agora = require('agora-access-token');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const isRender = process.env.NODE_ENV === 'production';
const activeCalls = new Map();
const pendingCalls = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: isRender ? ["https://beresta-server-5udn.onrender.com", "https://your-client-domain.com"] : "*",
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

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Используйте service_role key для сервера
const supabase = createClient(supabaseUrl, supabaseKey);

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

// Функция само-пинга для Render.com (только для поддержания активности сервера)
function startSelfPing() {
    const selfPingUrl = process.env.RENDER_SELF_PING_URL || `http://localhost:${PORT}`;
    
    if (isRender && selfPingUrl.includes('onrender.com')) {
        console.log('🔔 Активирован внутренний само-пинг для Render.com');
        
        const pingInterval = setInterval(() => {
            const url = new URL(selfPingUrl);
            const isHttps = url.protocol === 'https:';
            
            const httpModule = isHttps ? require('https') : require('http');
            
            httpModule.get(`${selfPingUrl}/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log('✅ Внутренний само-пинг успешен:', {
                        timestamp: new Date().toISOString(),
                        statusCode: res.statusCode
                    });
                });
            }).on('error', (err) => {
                console.error('❌ Ошибка внутреннего само-пинга:', err.message);
            });
        }, 4 * 60 * 1000); // Пинг каждые 4 минуты

        process.on('SIGINT', () => {
            clearInterval(pingInterval);
            console.log('🛑 Внутренний само-пинг остановлен');
        });
        
        process.on('SIGTERM', () => {
            clearInterval(pingInterval);
            console.log('🛑 Внутренний само-пинг остановлен');
        });
        
        return pingInterval;
    } else {
        console.log('ℹ️ Внутренний само-пинг отключен (не продакшен режим)');
        return null;
    }
}

// Функция определения типа файла
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

// Валидация имени канала Agora
function isValidChannelName(channelName) {
    const pattern = /^[a-zA-Z0-9!#$%&()+\-:;<=>.?@[\]^_{}|~]{1,64}$/;
    return pattern.test(channelName) && channelName.length <= 64;
}

// Функции для работы с Supabase

// Получение информации о пользователе
async function getUserInfo(email) {
    const { data: regularUser, error: regularError } = await supabase
        .from('regular_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

    if (regularUser) {
        return { ...regularUser, userType: 'regular' };
    }

    const { data: berestaUser, error: berestaError } = await supabase
        .from('beresta_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

    if (berestaUser) {
        return { ...berestaUser, userType: 'beresta' };
    }

    return null;
}

// Проверка существования пользователя
async function userExists(email) {
    const user = await getUserInfo(email);
    return user !== null;
}

// Автоматическое добавление в чаты
async function addToChatsAutomatically(user1, user2) {
    try {
        const user1Info = await getUserInfo(user1);
        const user2Info = await getUserInfo(user2);

        if (!user1Info || !user2Info) {
            console.log('⚠️ Один или оба пользователя не найдены');
            return;
        }

        // Добавляем запись для user1
        await supabase
            .from('friends')
            .upsert({ 
                user_email: user1.toLowerCase(), 
                friend_email: user2.toLowerCase() 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        // Добавляем запись для user2
        await supabase
            .from('friends')
            .upsert({ 
                user_email: user2.toLowerCase(), 
                friend_email: user1.toLowerCase() 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        console.log(`✅ Автоматически добавлены чаты: ${user1} ↔️ ${user2}`);
    } catch (error) {
        console.error('❌ Ошибка автоматического добавления в чаты:', error);
    }
}

// Health check эндпоинт
app.get('/health', async (req, res) => {
    try {
        // Проверка подключения к Supabase
        const { error } = await supabase.from('regular_users').select('count', { count: 'exact', head: true });
        
        if (error) throw error;
        
        // Проверка доступности директорий
        const dirs = [uploadDir, tempDir, permanentDir, thumbnailsDir];
        const dirStatus = {};
        dirs.forEach(dir => {
            dirStatus[dir] = fs.existsSync(dir);
        });
        
        const stats = {
            activeUsers: activeUsers.size,
            activeCalls: activeCalls.size,
            pendingCalls: pendingCalls.size,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: 'Supabase',
            databaseUrl: supabaseUrl,
            directories: dirStatus
        };
        
        res.json({ 
            success: true, 
            status: 'Server is running optimally',
            ...stats
        });
    } catch (error) {
        console.error('❌ Health check failed:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Health check failed',
            details: error.message 
        });
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

        const exists = await userExists(email);
        if (exists) {
            return res.status(409).json({ 
                success: false, 
                error: 'Пользователь уже существует' 
            });
        }

        const { data, error } = await supabase
            .from('regular_users')
            .insert([{ 
                email: email.toLowerCase(), 
                first_name: firstName, 
                last_name: lastName 
            }])
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'Пользователь успешно зарегистрирован',
            userId: data[0].id
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

        const exists = await userExists(email);
        if (exists) {
            return res.status(409).json({ 
                success: false, 
                error: 'Пользователь уже существует' 
            });
        }

        const { data, error } = await supabase
            .from('beresta_users')
            .insert([{ 
                email: email.toLowerCase(), 
                first_name: firstName, 
                last_name: lastName,
                beresta_id: berestaId 
            }])
            .select();

        if (error) throw error;

        res.json({
            success: true,
            message: 'Beresta ID пользователь зарегистрирован',
            userId: data[0].id
        });

    } catch (error) {
        console.error('❌ Ошибка регистрации Beresta ID:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение всех пользователей
app.get('/users', async (req, res) => {
    try {
        const { data: regularUsers, error: regularError } = await supabase
            .from('regular_users')
            .select('email, first_name, last_name')
            .order('first_name');

        const { data: berestaUsers, error: berestaError } = await supabase
            .from('beresta_users')
            .select('email, first_name, last_name')
            .order('first_name');

        if (regularError || berestaError) throw regularError || berestaError;

        const allUsers = [
            ...regularUsers.map(u => ({ ...u, userType: 'regular' })),
            ...berestaUsers.map(u => ({ ...u, userType: 'beresta' }))
        ];

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
        const user = await getUserInfo(email);

        if (!user) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        res.json({
            success: true,
            user: {
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                avatarFilename: user.avatar_filename || '',
                userType: user.userType,
                berestaId: user.beresta_id
            }
        });

    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление в друзья
app.post('/add-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        console.log('🔄 Добавление друга:', { userEmail, friendEmail });

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const normalizedUserEmail = userEmail.toLowerCase().trim();
        const normalizedFriendEmail = friendEmail.toLowerCase().trim();

        if (normalizedUserEmail === normalizedFriendEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'Нельзя добавить самого себя' 
            });
        }

        const userExistsCheck = await userExists(normalizedUserEmail);
        const friendExistsCheck = await userExists(normalizedFriendEmail);

        if (!userExistsCheck || !friendExistsCheck) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователи не найдены' 
            });
        }

        // Добавляем для первого пользователя
        const { error: error1 } = await supabase
            .from('friends')
            .upsert({ 
                user_email: normalizedUserEmail, 
                friend_email: normalizedFriendEmail 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        // Добавляем для второго пользователя
        const { error: error2 } = await supabase
            .from('friends')
            .upsert({ 
                user_email: normalizedFriendEmail, 
                friend_email: normalizedUserEmail 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        if (error1 || error2) throw error1 || error2;

        res.json({
            success: true,
            message: 'Друг добавлен',
            inserted: true
        });

    } catch (error) {
        console.error('❌ Ошибка добавления друга:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// Удаление из друзей
app.post('/remove-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const { error } = await supabase
            .from('friends')
            .delete()
            .eq('user_email', userEmail.toLowerCase())
            .eq('friend_email', friendEmail.toLowerCase());

        if (error) throw error;

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

        console.log('🔄 Получение чатов для:', userEmail);

        const { data: friends, error } = await supabase
            .from('friends')
            .select(`
                friend_email,
                regular_users!friends_friend_email_fkey (first_name, last_name),
                beresta_users!friends_friend_email_fkey (first_name, last_name)
            `)
            .eq('user_email', userEmail);

        if (error) throw error;

        // Получаем последние сообщения для каждого чата
        const chats = await Promise.all(friends.map(async (f) => {
            const friendEmail = f.friend_email;
            const userData = f.regular_users || f.beresta_users;
            
            const { data: messages, error: msgError } = await supabase
                .from('messages')
                .select('timestamp')
                .or(`and(sender_email.eq.${userEmail},receiver_email.eq.${friendEmail}),and(sender_email.eq.${friendEmail},receiver_email.eq.${userEmail})`)
                .order('timestamp', { ascending: false })
                .limit(1);

            if (msgError) throw msgError;

            return {
                contactEmail: friendEmail,
                firstName: userData?.first_name || '',
                lastName: userData?.last_name || '',
                type: 'friend',
                lastMessageTime: messages?.[0]?.timestamp || f.created_at
            };
        }));

        // Сортируем по времени последнего сообщения
        chats.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        console.log('✅ Найдено чатов:', chats.length);

        res.json({
            success: true,
            chats: chats
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

        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_email.eq.${userEmail},receiver_email.eq.${friendEmail}),and(sender_email.eq.${friendEmail},receiver_email.eq.${userEmail})`)
            .order('timestamp', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            messages: data
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

        const senderInfo = await getUserInfo(senderEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const { data, error } = await supabase
            .from('messages')
            .insert([{
                sender_email: senderEmail.toLowerCase(),
                receiver_email: receiverEmail.toLowerCase(),
                message: message || '',
                duration: duration || 0
            }])
            .select();

        if (error) throw error;

        res.json({
            success: true,
            messageId: data[0].id
        });

        addToChatsAutomatically(senderEmail, receiverEmail);

    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Принять звонок
app.post('/accept-call', async (req, res) => {
    try {
        const { channelName, receiverEmail } = req.body;

        if (!channelName || !receiverEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'channelName и receiverEmail обязательны' 
            });
        }

        pendingCalls.delete(receiverEmail.toLowerCase());

        const { error } = await supabase
            .from('agora_calls')
            .update({ status: 'accepted' })
            .eq('channel_name', channelName);

        if (error) throw error;

        console.log(`✅ Звонок принят: ${channelName} пользователем ${receiverEmail}`);

        res.json({
            success: true,
            message: 'Call accepted',
            channelName: channelName
        });

    } catch (error) {
        console.error('❌ Ошибка принятия звонка:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
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

        const senderInfo = await getUserInfo(senderEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = duration || 0;

        const completeFileUpload = async (thumbnail = '') => {
            try {
                const { data, error } = await supabase
                    .from('messages')
                    .insert([{
                        sender_email: senderEmail.toLowerCase(),
                        receiver_email: receiverEmail.toLowerCase(),
                        message: message || '',
                        attachment_type: fileType,
                        attachment_filename: req.file.filename,
                        attachment_original_name: req.file.originalname,
                        attachment_mime_type: req.file.mimetype,
                        attachment_size: req.file.size,
                        duration: videoDuration,
                        thumbnail: thumbnail
                    }])
                    .select();

                if (error) throw error;

                if (moveFileToPermanent(req.file.filename)) {
                    res.json({
                        success: true,
                        messageId: data[0].id,
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

        const senderInfo = await getUserInfo(senderEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const { data, error } = await supabase
            .from('messages')
            .insert([{
                sender_email: senderEmail.toLowerCase(),
                receiver_email: receiverEmail.toLowerCase(),
                message: message || '',
                attachment_type: attachmentType || '',
                attachment_filename: attachmentFilename || '',
                attachment_original_name: attachmentOriginalName || '',
                attachment_url: attachmentUrl || ''
            }])
            .select();

        if (error) throw error;

        res.json({
            success: true,
            messageId: data[0].id
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
            const field = isSender ? 'downloaded_by_sender' : 'downloaded_by_receiver';
            
            await supabase
                .from('messages')
                .update({ [field]: true })
                .eq('id', messageId);

            // Проверяем, нужно ли удалить файл
            const { data } = await supabase
                .from('messages')
                .select('downloaded_by_sender, downloaded_by_receiver, attachment_filename')
                .eq('id', messageId)
                .single();

            if (data?.downloaded_by_sender && data?.downloaded_by_receiver && data?.attachment_filename) {
                const fileToDelete = path.join(permanentDir, data.attachment_filename);
                if (fs.existsSync(fileToDelete)) {
                    fs.unlinkSync(fileToDelete);
                    console.log(`🗑️ Файл удален: ${data.attachment_filename}`);
                }
            }
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

        const { data, error } = await supabase
            .from('messages')
            .select('attachment_filename, attachment_original_name, attachment_mime_type, attachment_size, attachment_type')
            .eq('id', messageId)
            .single();

        if (error || !data?.attachment_filename) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        const filePath = path.join(permanentDir, data.attachment_filename);
        const exists = fs.existsSync(filePath);

        res.json({
            success: true,
            exists: exists,
            filename: data.attachment_filename,
            originalName: data.attachment_original_name,
            mimeType: data.attachment_mime_type,
            size: data.attachment_size,
            type: data.attachment_type
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

        const createdByInfo = await getUserInfo(createdBy);
        if (!createdByInfo) {
            return res.status(404).json({ success: false, error: 'Создатель не найден' });
        }

        // Создаем группу
        const { data: group, error: groupError } = await supabase
            .from('groups')
            .insert([{
                name: name,
                description: description || '',
                created_by: createdBy.toLowerCase()
            }])
            .select()
            .single();

        if (groupError) throw groupError;

        // Добавляем создателя как администратора
        const { error: memberError1 } = await supabase
            .from('group_members')
            .insert([{
                group_id: group.id,
                user_email: createdBy.toLowerCase(),
                role: 'admin'
            }]);

        if (memberError1) throw memberError1;

        // Добавляем остальных участников
        if (members && members.length > 0) {
            const memberInserts = members
                .filter(member => member !== createdBy)
                .map(member => ({
                    group_id: group.id,
                    user_email: member.toLowerCase()
                }));

            if (memberInserts.length > 0) {
                const { error: memberError2 } = await supabase
                    .from('group_members')
                    .insert(memberInserts, { ignoreDuplicates: true });

                if (memberError2) throw memberError2;
            }
        }

        res.json({
            success: true,
            groupId: group.id,
            message: 'Группа создана'
        });

    } catch (error) {
        console.error('❌ Ошибка создания группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение списка групп пользователя
app.get('/groups/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const { data, error } = await supabase
            .from('group_members')
            .select(`
                group_id,
                role,
                groups (
                    id,
                    name,
                    description,
                    created_by,
                    created_at
                )
            `)
            .eq('user_email', userEmail);

        if (error) throw error;

        // Получаем количество участников для каждой группы
        const groups = await Promise.all(data.map(async (item) => {
            const { count } = await supabase
                .from('group_members')
                .select('*', { count: 'exact', head: true })
                .eq('group_id', item.group_id);

            return {
                id: item.groups.id,
                name: item.groups.name,
                description: item.groups.description,
                created_by: item.groups.created_by,
                created_at: item.groups.created_at,
                role: item.role,
                member_count: count
            };
        }));

        res.json({
            success: true,
            groups: groups
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

        const { data, error } = await supabase
            .from('group_members')
            .select(`
                user_email,
                role,
                joined_at,
                regular_users!group_members_user_email_fkey (first_name, last_name),
                beresta_users!group_members_user_email_fkey (first_name, last_name)
            `)
            .eq('group_id', groupId);

        if (error) throw error;

        const members = data.map(m => {
            const userData = m.regular_users || m.beresta_users;
            return {
                email: m.user_email,
                first_name: userData?.first_name || '',
                last_name: userData?.last_name || '',
                role: m.role,
                joined_at: m.joined_at
            };
        });

        res.json({
            success: true,
            members: members
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

        const senderInfo = await getUserInfo(senderEmail);
        if (!senderInfo) {
            return res.status(404).json({ success: false, error: 'Отправитель не найден' });
        }

        const { data, error } = await supabase
            .from('group_messages')
            .insert([{
                group_id: groupId,
                sender_email: senderEmail.toLowerCase(),
                message: message || '',
                duration: duration || 0
            }])
            .select();

        if (error) throw error;

        res.json({
            success: true,
            messageId: data[0].id
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

        const { data, error } = await supabase
            .from('group_messages')
            .select(`
                *,
                regular_users!group_messages_sender_email_fkey (first_name, last_name),
                beresta_users!group_messages_sender_email_fkey (first_name, last_name)
            `)
            .eq('group_id', groupId)
            .order('timestamp', { ascending: true });

        if (error) throw error;

        const messages = data.map(m => {
            const userData = m.regular_users || m.beresta_users;
            return {
                ...m,
                first_name: userData?.first_name || '',
                last_name: userData?.last_name || ''
            };
        });

        res.json({
            success: true,
            messages: messages
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

        const userInfo = await getUserInfo(email);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        let avatarFilename = userInfo.avatar_filename;

        if (req.file) {
            if (moveFileToPermanent(req.file.filename)) {
                avatarFilename = req.file.filename;
            }
        } else if (removeAvatar === 'true') {
            avatarFilename = '';
        }

        const table = userInfo.userType === 'regular' ? 'regular_users' : 'beresta_users';

        const { error } = await supabase
            .from(table)
            .update({
                first_name: firstName,
                last_name: lastName,
                avatar_filename: avatarFilename
            })
            .eq('email', email.toLowerCase());

        if (error) throw error;

        res.json({
            success: true,
            message: 'Профиль обновлен',
            user: {
                email: email,
                firstName: firstName,
                lastName: lastName,
                avatarFilename: avatarFilename,
                userType: userInfo.userType
            }
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

        const callerInfo = await getUserInfo(callerEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

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

        const { data, error } = await supabase
            .from('agora_calls')
            .insert([{
                channel_name: channelName,
                caller_email: callerEmail.toLowerCase(),
                receiver_email: receiverEmail.toLowerCase(),
                call_type: callType || 'audio',
                status: 'ringing'
            }])
            .select();

        if (error) throw error;

        console.log('✅ Запись звонка создана');
        
        res.json({
            success: true,
            callId: data[0].id,
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

// Отправка звонка
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

        const callerInfo = await getUserInfo(callerEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

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

        await supabase
            .from('agora_calls')
            .upsert({
                channel_name: channelName,
                caller_email: callerEmail,
                receiver_email: normalizedReceiver,
                call_type: callType || 'audio',
                status: 'ringing'
            }, {
                onConflict: 'channel_name'
            });

        pendingCalls.set(normalizedReceiver, callData);
        
        setTimeout(() => {
            if (pendingCalls.get(normalizedReceiver)?.callId === callData.callId) {
                pendingCalls.delete(normalizedReceiver);
                console.log(`🗑️ Очищен ожидающий звонок для: ${normalizedReceiver}`);
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

        const { error } = await supabase
            .from('agora_calls')
            .update({ 
                status: 'ended', 
                ended_at: new Date().toISOString() 
            })
            .eq('channel_name', channelName);

        if (error) throw error;

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

        const { error } = await supabase
            .from('messages')
            .delete()
            .or(`and(sender_email.eq.${userEmail.toLowerCase()},receiver_email.eq.${friendEmail.toLowerCase()}),and(sender_email.eq.${friendEmail.toLowerCase()},receiver_email.eq.${userEmail.toLowerCase()})`);

        if (error) throw error;

        res.json({
            success: true,
            message: 'История чата очищена',
            deletedCount: 0
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

        const userInfo = await getUserInfo(userEmail);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const table = userInfo.userType === 'regular' ? 'regular_users' : 'beresta_users';

        const { error } = await supabase
            .from(table)
            .delete()
            .eq('email', userEmail);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Аккаунт удален',
            deletedCount: 1
        });
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

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

        const senderInfo = await getUserInfo(senderEmail);
        if (!senderInfo) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, error: 'Отправитель не найден' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = 0;

        const completeFileUpload = async (thumbnail = '') => {
            try {
                const { data, error } = await supabase
                    .from('group_messages')
                    .insert([{
                        group_id: groupId,
                        sender_email: senderEmail.toLowerCase(),
                        message: message || '',
                        attachment_type: fileType,
                        attachment_filename: req.file.filename,
                        attachment_original_name: req.file.originalname,
                        attachment_mime_type: req.file.mimetype,
                        attachment_size: req.file.size,
                        duration: videoDuration,
                        thumbnail: thumbnail
                    }])
                    .select();

                if (error) throw error;

                if (moveFileToPermanent(req.file.filename)) {
                    res.json({
                        success: true,
                        messageId: data[0].id,
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

        const { data, error } = await supabase
            .from('group_messages')
            .select('attachment_filename, attachment_original_name, attachment_mime_type, attachment_size, attachment_type')
            .eq('attachment_filename', filename)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        const filePath = path.join(permanentDir, data.attachment_filename);
        const exists = fs.existsSync(filePath);

        res.json({
            success: true,
            exists: exists,
            filename: data.attachment_filename,
            originalName: data.attachment_original_name,
            mimeType: data.attachment_mime_type,
            size: data.attachment_size,
            type: data.attachment_type
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
        
        const { data, error } = await supabase
            .from('agora_calls')
            .select('channel_name, caller_email, receiver_email, call_type, status, created_at')
            .eq('receiver_email', userEmail)
            .eq('status', 'ringing')
            .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) throw error;

        console.log(`📞 Найдено активных звонков: ${data.length}`);
        
        res.json({
            success: true,
            calls: data.map(call => ({
                channelName: call.channel_name,
                callerEmail: call.caller_email,
                receiverEmail: call.receiver_email,
                callType: call.call_type,
                status: call.status,
                createdAt: call.created_at
            })),
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

        const userInfo = await getUserInfo(userEmail);
        if (!userInfo) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const { error } = await supabase
            .from('group_members')
            .upsert({
                group_id: groupId,
                user_email: userEmail.toLowerCase()
            }, {
                onConflict: 'group_id,user_email',
                ignoreDuplicates: true
            });

        if (error) throw error;

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

        const { error } = await supabase
            .from('group_members')
            .delete()
            .eq('group_id', groupId)
            .eq('user_email', userEmail.toLowerCase());

        if (error) throw error;

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

        const { error } = await supabase
            .from('groups')
            .delete()
            .eq('id', groupId);

        if (error) throw error;

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
    console.log(`🔗 Внешний URL: https://beresta-server-5udn.onrender.com`);
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    
    console.log('✅ Сервер готов к работе');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});
