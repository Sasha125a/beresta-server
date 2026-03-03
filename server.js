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

// ==================== КОНФИГУРАЦИЯ ====================
const isRender = process.env.NODE_ENV === 'production';
const SERVER_ID = process.env.RENDER_SERVICE_ID || `server-${Math.random().toString(36).substring(7)}`;

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: isRender ? ["https://beresta-server-5udn.onrender.com"] : "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));

// ==================== ФАЙЛОВОЕ ХРАНИЛИЩЕ ====================
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
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'file_' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: multerStorage,
    limits: { fileSize: 100 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, true)
});

// ==================== FFMPEG ====================
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

// Определение типа файла
function getFileType(mimetype, filename) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.txt'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z'].includes(ext)) return 'archive';
    
    return 'file';
}

// Перемещение файла из временной в постоянную папку
function moveFileToPermanent(filename) {
    const tempPath = path.join(tempDir, filename);
    const permanentPath = path.join(permanentDir, filename);
    
    if (fs.existsSync(tempPath)) {
        try {
            fs.renameSync(tempPath, permanentPath);
            return true;
        } catch (error) {
            console.error(`❌ Ошибка перемещения файла ${filename}:`, error);
            return false;
        }
    }
    return false;
}

// Получение длительности видео
function getVideoDuration(videoPath, callback) {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return callback(err);
        callback(null, Math.round(metadata.format.duration || 0));
    });
}

// Создание превью
function createMediaPreview(filePath, outputPath, fileType, callback) {
    const command = ffmpeg(filePath);
    
    if (fileType === 'video') {
        command.screenshots({
            timestamps: ['00:00:01'],
            filename: path.basename(outputPath),
            folder: path.dirname(outputPath),
            size: '320x240'
        }).on('end', () => callback(null, outputPath)).on('error', callback);
    } else if (fileType === 'image') {
        command.size('320x240').output(outputPath)
            .on('end', () => callback(null, outputPath))
            .on('error', callback)
            .run();
    } else {
        callback(new Error('Unsupported file type'));
    }
}

// Получение информации о пользователе
async function getUserInfo(email) {
    const { data: regularUser } = await supabase
        .from('regular_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

    if (regularUser) return { ...regularUser, userType: 'regular' };

    const { data: berestaUser } = await supabase
        .from('beresta_users')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

    if (berestaUser) return { ...berestaUser, userType: 'beresta' };

    return null;
}

// Проверка существования пользователя
async function userExists(email) {
    return !!(await getUserInfo(email));
}

// Автоматическое добавление в чаты
async function addToChatsAutomatically(user1, user2) {
    try {
        await supabase.from('friends').upsert({ user_email: user1.toLowerCase(), friend_email: user2.toLowerCase() }, { onConflict: 'user_email,friend_email', ignoreDuplicates: true });
        await supabase.from('friends').upsert({ user_email: user2.toLowerCase(), friend_email: user1.toLowerCase() }, { onConflict: 'user_email,friend_email', ignoreDuplicates: true });
    } catch (error) {
        console.error('❌ Ошибка добавления в чаты:', error);
    }
}

// ==================== ФУНКЦИИ ДЛЯ МУЛЬТИ-СЕРВЕРНОЙ АРХИТЕКТУРЫ ====================

// Обновление присутствия пользователя
async function updateUserPresence(email, socketId, status = 'online') {
    try {
        await supabase
            .from('user_presence')
            .upsert({
                user_email: email.toLowerCase(),
                socket_id: socketId,
                server_id: SERVER_ID,
                last_seen: new Date().toISOString(),
                status: status
            }, { onConflict: 'user_email' });
    } catch (error) {
        console.error('❌ Ошибка обновления присутствия:', error);
    }
}

// Получение socket_id пользователя
async function getUserSocketId(email) {
    try {
        const { data } = await supabase
            .from('user_presence')
            .select('socket_id, server_id, last_seen')
            .eq('user_email', email.toLowerCase())
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString())
            .single();
        return data;
    } catch {
        return null;
    }
}

// Очистка старых записей присутствия
async function cleanupOldPresence() {
    try {
        await supabase
            .from('user_presence')
            .delete()
            .lt('last_seen', new Date(Date.now() - 60000).toISOString());
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
}

// ==================== WEB-SOCKET ====================

io.on('connection', (socket) => {
    console.log('✅ WebSocket подключен:', socket.id);

    socket.on('user_online', async (data) => {
        try {
            if (data?.email) {
                const email = data.email.toLowerCase();
                socket.userEmail = email;
                
                await updateUserPresence(email, socket.id, 'online');
                
                socket.broadcast.emit('user_status_changed', {
                    email: email,
                    status: 'online',
                    timestamp: new Date().toISOString()
                });

                socket.emit('user_online_confirmed', {
                    status: 'confirmed',
                    email: email,
                    serverId: SERVER_ID
                });
            }
        } catch (error) {
            console.error('❌ Ошибка user_online:', error);
        }
    });

    socket.on('ping', (data) => {
        socket.emit('pong', { ...data, serverTime: new Date().toISOString() });
    });

    socket.on('call_notification', async (data) => {
        try {
            if (!data?.receiverEmail) return;

            const receiverEmail = data.receiverEmail.toLowerCase();
            const receiverPresence = await getUserSocketId(receiverEmail);

            if (receiverPresence && receiverPresence.server_id === SERVER_ID) {
                io.to(receiverPresence.socket_id).emit('incoming_call', {
                    type: 'incoming_call',
                    channelName: data.channelName,
                    callerEmail: data.callerEmail,
                    callerName: data.callerName || data.callerEmail,
                    callType: data.callType || 'audio',
                    callId: data.callId
                });
                
                socket.emit('call_notification_sent', { success: true });
            } else {
                socket.emit('call_notification_failed', { 
                    error: 'USER_OFFLINE',
                    receiver: receiverEmail 
                });
            }
        } catch (error) {
            console.error('❌ Ошибка call_notification:', error);
        }
    });

    socket.on('disconnect', async (reason) => {
        if (socket.userEmail) {
            await updateUserPresence(socket.userEmail, socket.id, 'offline');
            
            socket.broadcast.emit('user_status_changed', {
                email: socket.userEmail,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        }
    });
});

// Запускаем очистку присутствия раз в минуту
setInterval(cleanupOldPresence, 60000);

// ==================== API ЭНДПОИНТЫ ====================

// Health check
app.get('/health', async (req, res) => {
    try {
        const { count } = await supabase
            .from('user_presence')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        res.json({
            success: true,
            status: 'running',
            serverId: SERVER_ID,
            onlineUsers: count || 0,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Регистрация
app.post('/register', async (req, res) => {
    try {
        const { email, firstName, lastName } = req.body;

        if (!email || !firstName || !lastName) {
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        const exists = await userExists(email);
        if (exists) {
            return res.status(409).json({ success: false, error: 'Пользователь уже существует' });
        }

        const { data, error } = await supabase
            .from('regular_users')
            .insert([{ email: email.toLowerCase(), first_name: firstName, last_name: lastName }])
            .select();

        if (error) throw error;

        res.json({ success: true, userId: data[0].id });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Регистрация Beresta
app.post('/register-beresta', async (req, res) => {
    try {
        const { email, firstName, lastName, berestaId } = req.body;

        if (!email || !firstName || !lastName || !berestaId) {
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        const exists = await userExists(email);
        if (exists) {
            return res.status(409).json({ success: false, error: 'Пользователь уже существует' });
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

        res.json({ success: true, userId: data[0].id });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение пользователей
app.get('/users', async (req, res) => {
    try {
        const [regular, beresta] = await Promise.all([
            supabase.from('regular_users').select('email, first_name, last_name'),
            supabase.from('beresta_users').select('email, first_name, last_name, beresta_id')
        ]);

        const allUsers = [
            ...(regular.data || []).map(u => ({ ...u, userType: 'regular' })),
            ...(beresta.data || []).map(u => ({ ...u, userType: 'beresta' }))
        ];

        res.json({ success: true, users: allUsers });
    } catch (error) {
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

        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение чатов пользователя
app.get('/chats/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        const { data: friends, error } = await supabase
            .from('friends')
            .select('friend_email, created_at')
            .eq('user_email', userEmail);

        if (error) throw error;

        const chats = await Promise.all((friends || []).map(async (f) => {
            const friendEmail = f.friend_email;
            const friendInfo = await getUserInfo(friendEmail);

            const { data: messages } = await supabase
                .from('messages')
                .select('timestamp')
                .or(`and(sender_email.eq.${userEmail},receiver_email.eq.${friendEmail}),and(sender_email.eq.${friendEmail},receiver_email.eq.${userEmail})`)
                .order('timestamp', { ascending: false })
                .limit(1);

            return {
                contactEmail: friendEmail,
                firstName: friendInfo?.first_name || '',
                lastName: friendInfo?.last_name || '',
                type: 'friend',
                lastMessageTime: messages?.[0]?.timestamp || f.created_at
            };
        }));

        chats.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        res.json({ success: true, chats });
    } catch (error) {
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

        res.json({ success: true, messages: data || [] });
    } catch (error) {
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

        await addToChatsAutomatically(senderEmail, receiverEmail);

        res.json({ success: true, messageId: data[0].id });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Загрузка файла
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const { senderEmail, receiverEmail, message } = req.body;

        if (!senderEmail || !receiverEmail) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = 0;

        const saveToDb = async (thumbnail = '') => {
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
                    await addToChatsAutomatically(senderEmail, receiverEmail);
                    res.json({ success: true, messageId: data[0].id, filename: req.file.filename });
                } else {
                    throw new Error('Ошибка перемещения файла');
                }
            } catch (error) {
                fs.unlinkSync(req.file.path);
                if (thumbnail) fs.unlinkSync(path.join(thumbnailsDir, thumbnail));
                throw error;
            }
        };

        if (fileType === 'image' || fileType === 'video') {
            const previewName = `preview_${path.parse(req.file.filename).name}.jpg`;
            const previewPath = path.join(thumbnailsDir, previewName);

            if (fileType === 'video') {
                getVideoDuration(req.file.path, (err, duration) => {
                    if (!err) videoDuration = duration;
                    createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                        saveToDb(err ? '' : previewName);
                    });
                });
            } else {
                createMediaPreview(req.file.path, previewPath, fileType, (err) => {
                    saveToDb(err ? '' : previewName);
                });
            }
        } else {
            await saveToDb();
        }
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Скачивание файла
app.get('/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(permanentDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }

        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        const originalName = req.query.originalName || filename;

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
        
        fs.createReadStream(filePath).pipe(res);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Добавление друга
app.post('/add-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        await supabase.from('friends').upsert({ user_email: userEmail.toLowerCase(), friend_email: friendEmail.toLowerCase() }, { onConflict: 'user_email,friend_email', ignoreDuplicates: true });
        await supabase.from('friends').upsert({ user_email: friendEmail.toLowerCase(), friend_email: userEmail.toLowerCase() }, { onConflict: 'user_email,friend_email', ignoreDuplicates: true });

        res.json({ success: true, message: 'Друг добавлен' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Agora токен
app.get('/agora/token/:channelName/:userId', (req, res) => {
    try {
        const { channelName, userId } = req.params;
        
        const appId = process.env.AGORA_APP_ID || '0eef2fbc530f4d27a19a18f6527dda20';
        const appCertificate = process.env.AGORA_APP_CERTIFICATE || '5ffaa1348ef5433b8fbb37d22772ca0e';
        
        const token = Agora.RtcTokenBuilder.buildTokenWithUid(
            appId,
            appCertificate,
            channelName,
            Math.abs(parseInt(userId) || 0),
            Agora.RtcRole.PUBLISHER,
            Math.floor(Date.now() / 1000) + 3600
        );

        res.json({ success: true, token, appId, channelName });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ==================== ЗВОНКИ (МУЛЬТИ-СЕРВЕРНЫЕ) ====================

// Создание звонка
app.post('/send-call', async (req, res) => {
    try {
        const { channelName, callerEmail, receiverEmail, callType, callerName } = req.body;

        if (!channelName || !callerEmail || !receiverEmail) {
            return res.status(400).json({ success: false, error: 'Все поля обязательны' });
        }

        const callId = Date.now().toString();
        
        const { data: call, error } = await supabase
            .from('active_calls')
            .insert({
                call_id: callId,
                channel_name: channelName,
                caller_email: callerEmail.toLowerCase(),
                receiver_email: receiverEmail.toLowerCase(),
                call_type: callType || 'audio',
                status: 'ringing',
                expires_at: new Date(Date.now() + 60000).toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        const receiverPresence = await getUserSocketId(receiverEmail);
        
        if (receiverPresence && receiverPresence.server_id === SERVER_ID) {
            io.to(receiverPresence.socket_id).emit('incoming_call', {
                channelName,
                callerEmail,
                callerName: callerName || callerEmail,
                callType: callType || 'audio',
                callId
            });
        }

        res.json({ success: true, callId });
    } catch (error) {
        console.error('❌ Ошибка создания звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Проверка входящих звонков (long-polling)
app.get('/check-incoming-calls/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        const timeout = parseInt(req.query.timeout) || 30000;

        const checkCalls = async () => {
            const { data } = await supabase
                .from('active_calls')
                .select('*')
                .eq('receiver_email', userEmail)
                .eq('status', 'ringing')
                .gt('expires_at', new Date().toISOString())
                .limit(1);

            return data?.[0] || null;
        };

        let call = await checkCalls();
        if (call) {
            await supabase.from('active_calls').update({ status: 'delivered' }).eq('call_id', call.call_id);
            return res.json({
                success: true,
                hasCall: true,
                call: {
                    channelName: call.channel_name,
                    callerEmail: call.caller_email,
                    callType: call.call_type,
                    callId: call.call_id
                }
            });
        }

        const interval = setInterval(async () => {
            const newCall = await checkCalls();
            if (newCall) {
                clearInterval(interval);
                clearTimeout(timeoutHandle);
                if (!res.headersSent) {
                    await supabase.from('active_calls').update({ status: 'delivered' }).eq('call_id', newCall.call_id);
                    res.json({
                        success: true,
                        hasCall: true,
                        call: {
                            channelName: newCall.channel_name,
                            callerEmail: newCall.caller_email,
                            callType: newCall.call_type,
                            callId: newCall.call_id
                        }
                    });
                }
            }
        }, 2000);

        const timeoutHandle = setTimeout(() => {
            clearInterval(interval);
            if (!res.headersSent) {
                res.json({ success: true, hasCall: false });
            }
        }, timeout);

        req.on('close', () => {
            clearInterval(interval);
            clearTimeout(timeoutHandle);
        });

    } catch (error) {
        console.error('❌ Ошибка проверки звонков:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    }
});

// Принятие звонка
app.post('/accept-call', async (req, res) => {
    try {
        const { channelName, receiverEmail } = req.body;

        const { data: call } = await supabase
            .from('active_calls')
            .update({ status: 'accepted' })
            .eq('channel_name', channelName)
            .select()
            .single();

        if (call) {
            const callerPresence = await getUserSocketId(call.caller_email);
            if (callerPresence && callerPresence.server_id === SERVER_ID) {
                io.to(callerPresence.socket_id).emit('call_accepted', { channelName });
            }
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Завершение звонка
app.post('/end-call', async (req, res) => {
    try {
        const { channelName } = req.body;

        await supabase
            .from('active_calls')
            .update({ status: 'ended' })
            .eq('channel_name', channelName);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Получение онлайн пользователей
app.get('/online-users', async (req, res) => {
    try {
        const { data } = await supabase
            .from('user_presence')
            .select('user_email, server_id, last_seen')
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        res.json({
            success: true,
            online: (data || []).map(u => ({
                email: u.user_email,
                server: u.server_id
            })),
            count: data?.length || 0
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Статические файлы
app.use('/uploads', express.static(uploadDir));

// ==================== ЗАПУСК СЕРВЕРА ====================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🆔 Server ID: ${SERVER_ID}`);
    console.log(`🌐 Режим: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 WebSocket: порт ${PORT}`);
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
});
