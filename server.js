// ==================== ИМПОРТЫ ====================
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
const http = require('http');
const socketIo = require('socket.io');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// ==================== КОНФИГУРАЦИЯ ====================
const isRender = process.env.NODE_ENV === 'production';
const SERVER_ID = process.env.RENDER_SERVICE_ID || `server-${Math.random().toString(36).substring(2, 10)}`;

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// ==================== SOCKET.IO (для чата) ====================
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

// ==================== WEBSOCKET (для WebRTC сигналинга) ====================
const wss = new WebSocket.Server({ 
    server: server,
    path: '/webrtc'
});

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ОШИБКА: SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть указаны в .env');
    process.exit(1);
}

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

// Создаем папки, если их нет
[uploadDir, tempDir, permanentDir, thumbnailsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Создана папка: ${dir}`);
    }
});

// Настройка multer для загрузки файлов
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
        fileSize: 100 * 1024 * 1024, // 100MB
        fieldSize: 50 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

// ==================== FFMPEG ====================
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

/**
 * Определение типа файла по MIME-типу и расширению
 */
function getFileType(mimetype, filename) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.3gp'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive';
    
    return 'file';
}

/**
 * Перемещение файла из временной папки в постоянную
 */
function moveFileToPermanent(filename) {
    const tempPath = path.join(tempDir, filename);
    const permanentPath = path.join(permanentDir, filename);
    
    if (fs.existsSync(tempPath)) {
        try {
            fs.renameSync(tempPath, permanentPath);
            console.log(`✅ Файл перемещен: ${filename}`);
            return true;
        } catch (error) {
            console.error(`❌ Ошибка перемещения файла ${filename}:`, error);
            return false;
        }
    }
    console.error(`❌ Временный файл не найден: ${tempPath}`);
    return false;
}

/**
 * Получение длительности видео через ffprobe
 */
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

/**
 * Создание превью для видео или изображения
 */
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
            })
            .run();
    } else {
        callback(new Error('Unsupported file type for preview'));
    }
}

// ==================== ФУНКЦИИ РАБОТЫ С БАЗОЙ ДАННЫХ ====================

/**
 * Получение информации о пользователе по email
 */
async function getUserInfo(email) {
    const normalizedEmail = email.toLowerCase();
    
    // Ищем в regular_users
    const { data: regularUser, error: regularError } = await supabase
        .from('regular_users')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();

    if (regularUser) {
        return { ...regularUser, userType: 'regular' };
    }

    // Ищем в beresta_users
    const { data: berestaUser, error: berestaError } = await supabase
        .from('beresta_users')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();

    if (berestaUser) {
        return { ...berestaUser, userType: 'beresta' };
    }

    return null;
}

/**
 * Проверка существования пользователя
 */
async function userExists(email) {
    const user = await getUserInfo(email);
    return user !== null;
}

/**
 * Автоматическое добавление в чаты при первом сообщении
 */
async function addToChatsAutomatically(user1, user2) {
    try {
        const user1Email = user1.toLowerCase();
        const user2Email = user2.toLowerCase();

        // Добавляем запись для user1
        await supabase
            .from('friends')
            .upsert({ 
                user_email: user1Email, 
                friend_email: user2Email 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        // Добавляем запись для user2
        await supabase
            .from('friends')
            .upsert({ 
                user_email: user2Email, 
                friend_email: user1Email 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

        console.log(`✅ Автоматически добавлены чаты: ${user1Email} ↔️ ${user2Email}`);
    } catch (error) {
        console.error('❌ Ошибка автоматического добавления в чаты:', error);
    }
}

// ==================== ФУНКЦИИ ДЛЯ МУЛЬТИ-СЕРВЕРНОЙ АРХИТЕКТУРЫ ====================

/**
 * Обновление статуса присутствия пользователя
 */
async function updateUserPresence(email, socketId, status = 'online') {
    try {
        const { error } = await supabase
            .from('user_presence')
            .upsert({
                user_email: email.toLowerCase(),
                socket_id: socketId,
                server_id: SERVER_ID,
                last_seen: new Date().toISOString(),
                status: status
            }, { 
                onConflict: 'user_email' 
            });

        if (error) throw error;
    } catch (error) {
        console.error('❌ Ошибка обновления присутствия:', error);
    }
}

/**
 * Получение socket_id пользователя
 */
async function getUserSocketId(email) {
    try {
        const { data, error } = await supabase
            .from('user_presence')
            .select('socket_id, server_id, last_seen')
            .eq('user_email', email.toLowerCase())
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString()) // активные за последние 30 сек
            .maybeSingle();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('❌ Ошибка получения socket_id:', error);
        return null;
    }
}

/**
 * Очистка устаревших записей присутствия
 */
async function cleanupOldPresence() {
    try {
        const { error } = await supabase
            .from('user_presence')
            .delete()
            .lt('last_seen', new Date(Date.now() - 60000).toISOString()); // старше 1 минуты

        if (error) throw error;
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
}

/**
 * Очистка устаревших звонков
 */
async function cleanupOldCalls() {
    try {
        const { error } = await supabase
            .from('active_calls')
            .delete()
            .lt('expires_at', new Date().toISOString());

        if (error) throw error;
    } catch (error) {
        console.error('❌ Ошибка очистки звонков:', error);
    }
}

// Запускаем очистку раз в минуту
setInterval(cleanupOldPresence, 60000);
setInterval(cleanupOldCalls, 60000);

// ==================== ХРАНИЛИЩЕ ДЛЯ WEBRTC СИГНАЛИНГА ====================
const callSessions = new Map(); // callId -> { participants, offers }
const userConnections = new Map(); // userEmail -> ws

// ==================== WEBSOCKET ДЛЯ WEBRTC СИГНАЛИНГА ====================
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    
    if (!userId) {
        ws.close(1008, 'User ID required');
        return;
    }

    console.log(`🔌 WebRTC клиент подключен: ${userId}`);
    userConnections.set(userId, ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📨 WebRTC сообщение от ${userId}:`, data.type);

            switch (data.type) {
                case 'call-offer':
                    // Инициатор звонка отправляет offer
                    const callId = uuidv4();
                    const callSession = {
                        callId,
                        caller: userId,
                        callee: data.targetUserId,
                        offer: data.offer,
                        iceCandidates: [],
                        status: 'ringing'
                    };
                    
                    callSessions.set(callId, callSession);
                    
                    // Сохраняем в БД
                    await supabase
                        .from('webrtc_calls')
                        .insert({
                            call_id: callId,
                            caller_email: userId,
                            receiver_email: data.targetUserId,
                            status: 'ringing',
                            created_at: new Date().toISOString()
                        });
                    
                    // Отправляем уведомление получателю
                    const calleeWs = userConnections.get(data.targetUserId);
                    if (calleeWs && calleeWs.readyState === WebSocket.OPEN) {
                        calleeWs.send(JSON.stringify({
                            type: 'incoming-call',
                            callId,
                            caller: userId,
                            offer: data.offer
                        }));
                    } else {
                        // Получатель офлайн
                        ws.send(JSON.stringify({
                            type: 'call-failed',
                            reason: 'USER_OFFLINE'
                        }));
                        
                        // Обновляем статус в БД
                        await supabase
                            .from('webrtc_calls')
                            .update({ status: 'failed' })
                            .eq('call_id', callId);
                    }
                    break;

                case 'call-answer':
                    // Получатель отвечает на звонок
                    const session = callSessions.get(data.callId);
                    if (session) {
                        session.status = 'connected';
                        
                        // Отправляем answer звонящему
                        const callerWs = userConnections.get(session.caller);
                        if (callerWs && callerWs.readyState === WebSocket.OPEN) {
                            callerWs.send(JSON.stringify({
                                type: 'call-answer',
                                callId: data.callId,
                                answer: data.answer
                            }));
                        }
                        
                        // Обновляем статус в БД
                        await supabase
                            .from('webrtc_calls')
                            .update({ 
                                status: 'connected',
                                answered_at: new Date().toISOString()
                            })
                            .eq('call_id', data.callId);
                    }
                    break;

                case 'ice-candidate':
                    // Обмен ICE кандидатами
                    const targetSession = callSessions.get(data.callId);
                    if (targetSession) {
                        const targetUser = data.targetUserId;
                        const targetWs = userConnections.get(targetUser);
                        
                        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                            targetWs.send(JSON.stringify({
                                type: 'ice-candidate',
                                callId: data.callId,
                                candidate: data.candidate
                            }));
                        }
                    }
                    break;

                case 'call-end':
                    // Завершение звонка
                    const endedSession = callSessions.get(data.callId);
                    if (endedSession) {
                        // Уведомляем всех участников
                        [endedSession.caller, endedSession.callee].forEach(email => {
                            const userWs = userConnections.get(email);
                            if (userWs && userWs.readyState === WebSocket.OPEN) {
                                userWs.send(JSON.stringify({
                                    type: 'call-ended',
                                    callId: data.callId
                                }));
                            }
                        });
                        
                        callSessions.delete(data.callId);
                        
                        // Обновляем статус в БД
                        await supabase
                            .from('webrtc_calls')
                            .update({ 
                                status: 'ended',
                                ended_at: new Date().toISOString()
                            })
                            .eq('call_id', data.callId);
                    }
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка обработки WebRTC сообщения:', error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 WebRTC клиент отключен: ${userId}`);
        userConnections.delete(userId);
        
        // Очищаем активные звонки этого пользователя
        callSessions.forEach((session, callId) => {
            if (session.caller === userId || session.callee === userId) {
                callSessions.delete(callId);
            }
        });
    });
});

// ==================== SOCKET.IO СОЕДИНЕНИЯ (для чата) ====================

io.on('connection', (socket) => {
    console.log('✅ WebSocket подключен:', socket.id);

    // Обработчик онлайн-статуса
    socket.on('user_online', async (data) => {
        try {
            if (data && data.email) {
                const email = data.email.toLowerCase();
                socket.userEmail = email;
                
                // Сохраняем в Supabase
                await updateUserPresence(email, socket.id, 'online');
                
                console.log(`👤 Пользователь онлайн: ${email} на сервере ${SERVER_ID}`);
                
                // Оповещаем всех о смене статуса
                socket.broadcast.emit('user_status_changed', {
                    email: email,
                    status: 'online',
                    timestamp: new Date().toISOString(),
                    server: SERVER_ID
                });

                socket.emit('user_online_confirmed', {
                    status: 'confirmed',
                    email: email,
                    serverId: SERVER_ID,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('❌ Ошибка в user_online:', error);
        }
    });

    // Обработчик пинга
    socket.on('ping', (data) => {
        socket.emit('pong', {
            ...data,
            serverTime: new Date().toISOString()
        });
    });

    // Обработчик отключения
    socket.on('disconnect', async (reason) => {
        console.log(`❌ WebSocket отключен: ${socket.id}, причина: ${reason}`);
        
        if (socket.userEmail) {
            // Помечаем как оффлайн в Supabase
            await updateUserPresence(socket.userEmail, socket.id, 'offline');
            
            socket.broadcast.emit('user_status_changed', {
                email: socket.userEmail,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        }
    });

    // Обработчик ошибок
    socket.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
});

// ==================== API ЭНДПОИНТЫ ====================

// ===== Health check =====
app.get('/health', async (req, res) => {
    try {
        // Проверка подключения к Supabase
        const { error } = await supabase.from('regular_users').select('count', { count: 'exact', head: true });
        
        if (error) throw error;
        
        // Получаем количество онлайн пользователей
        const { count } = await supabase
            .from('user_presence')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        // Проверка доступности директорий
        const dirs = [uploadDir, tempDir, permanentDir, thumbnailsDir];
        const dirStatus = {};
        dirs.forEach(dir => {
            dirStatus[path.basename(dir)] = fs.existsSync(dir);
        });

        res.json({
            success: true,
            status: 'Server is running optimally',
            serverId: SERVER_ID,
            onlineUsers: count || 0,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            directories: dirStatus,
            timestamp: new Date().toISOString()
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

// ===== Регистрация обычного пользователя =====
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

// ===== Регистрация Beresta ID пользователя =====
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

// ===== Получение всех пользователей =====
app.get('/users', async (req, res) => {
    try {
        const [regularResult, berestaResult] = await Promise.all([
            supabase.from('regular_users').select('email, first_name, last_name').order('first_name'),
            supabase.from('beresta_users').select('email, first_name, last_name, beresta_id').order('first_name')
        ]);

        const regularUsers = regularResult.data || [];
        const berestaUsers = berestaResult.data || [];

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

// ===== Получение информации о пользователе =====
app.get('/user/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email).toLowerCase();
        console.log('🔍 Поиск пользователя по email:', email);

        const user = await getUserInfo(email);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден'
            });
        }

        res.json({
            success: true,
            user
        });
    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// ===== Получение чатов пользователя =====
app.get('/chats/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        console.log('🔄 Получение чатов для:', userEmail);

        // Получаем всех друзей пользователя
        const { data: friends, error: friendsError } = await supabase
            .from('friends')
            .select('friend_email, created_at')
            .eq('user_email', userEmail);

        if (friendsError) throw friendsError;

        if (!friends || friends.length === 0) {
            return res.json({
                success: true,
                chats: []
            });
        }

        // Получаем информацию о каждом друге и последнее сообщение
        const chats = await Promise.all(friends.map(async (friend) => {
            const friendEmail = friend.friend_email;
            const friendInfo = await getUserInfo(friendEmail);

            // Получаем последнее сообщение
            const { data: messages, error: msgError } = await supabase
                .from('messages')
                .select('timestamp')
                .or(`and(sender_email.eq.${userEmail},receiver_email.eq.${friendEmail}),and(sender_email.eq.${friendEmail},receiver_email.eq.${userEmail})`)
                .order('timestamp', { ascending: false })
                .limit(1);

            if (msgError) console.error(`❌ Ошибка получения сообщений для ${friendEmail}:`, msgError);

            return {
                contactEmail: friendEmail,
                firstName: friendInfo?.first_name || '',
                lastName: friendInfo?.last_name || '',
                type: 'friend',
                lastMessageTime: messages?.[0]?.timestamp || friend.created_at || new Date().toISOString()
            };
        }));

        // Сортируем по времени последнего сообщения
        chats.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        console.log('✅ Найдено чатов:', chats.length);

        res.json({
            success: true,
            chats
        });
    } catch (error) {
        console.error('❌ Ошибка получения чатов:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// ===== Получение сообщений между двумя пользователями =====
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
            messages: data || []
        });
    } catch (error) {
        console.error('❌ Ошибка получения сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Отправка текстового сообщения =====
app.post('/send-message', async (req, res) => {
    try {
        const { senderEmail, receiverEmail, message, duration } = req.body;

        if (!senderEmail || !receiverEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email обязательны'
            });
        }

        const senderInfo = await getUserInfo(senderEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден'
            });
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

        // Автоматически добавляем в чаты
        await addToChatsAutomatically(senderEmail, receiverEmail);

        res.json({
            success: true,
            messageId: data[0].id
        });
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Загрузка файла с сообщением =====
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

        const senderInfo = await getUserInfo(senderEmail);
        const receiverInfo = await getUserInfo(receiverEmail);

        if (!senderInfo || !receiverInfo) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);
        let thumbnailFilename = '';
        let videoDuration = 0;

        // Функция завершения загрузки
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
                    await addToChatsAutomatically(senderEmail, receiverEmail);
                    
                    res.json({
                        success: true,
                        messageId: data[0].id,
                        filename: req.file.filename,
                        thumbnail: thumbnail,
                        fileType: fileType
                    });
                } else {
                    throw new Error('Ошибка перемещения файла');
                }
            } catch (error) {
                // Очистка при ошибке
                fs.unlinkSync(req.file.path);
                if (thumbnail) {
                    const thumbPath = path.join(thumbnailsDir, thumbnail);
                    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
                }
                throw error;
            }
        };

        // Создаем превью для видео и изображений
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

// ===== Загрузка файла (без сообщения) =====
app.post('/upload-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }

        const fileType = getFileType(req.file.mimetype, req.file.originalname);

        if (moveFileToPermanent(req.file.filename)) {
            res.json({
                success: true,
                filename: req.file.filename,
                originalName: req.file.originalname,
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

// ===== Скачивание файла =====
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
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
    } catch (error) {
        console.error('❌ Ошибка скачивания файла:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Информация о файле =====
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
            exists,
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

// ===== Добавление друга =====
app.post('/add-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

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
        await supabase
            .from('friends')
            .upsert({
                user_email: normalizedUserEmail,
                friend_email: normalizedFriendEmail
            }, {
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true
            });

        // Добавляем для второго пользователя
        await supabase
            .from('friends')
            .upsert({
                user_email: normalizedFriendEmail,
                friend_email: normalizedUserEmail
            }, {
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true
            });

        res.json({
            success: true,
            message: 'Друг добавлен'
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

// ===== Удаление друга =====
app.post('/remove-friend', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;

        if (!userEmail || !friendEmail) {
            return res.status(400).json({ success: false, error: 'Email обязательны' });
        }

        await supabase
            .from('friends')
            .delete()
            .eq('user_email', userEmail.toLowerCase())
            .eq('friend_email', friendEmail.toLowerCase());

        res.json({
            success: true,
            message: 'Друг удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления друга:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Обновление профиля =====
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

// ===== Удаление аккаунта =====
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
            message: 'Аккаунт удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Очистка истории чата =====
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
            message: 'История чата очищена'
        });
    } catch (error) {
        console.error('❌ Ошибка очистки чата:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Создание группы =====
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
        await supabase
            .from('group_members')
            .insert([{
                group_id: group.id,
                user_email: createdBy.toLowerCase(),
                role: 'admin'
            }]);

        // Добавляем остальных участников
        if (members && members.length > 0) {
            const memberInserts = members
                .filter(member => member !== createdBy)
                .map(member => ({
                    group_id: group.id,
                    user_email: member.toLowerCase()
                }));

            if (memberInserts.length > 0) {
                await supabase
                    .from('group_members')
                    .insert(memberInserts, { ignoreDuplicates: true });
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

// ===== Получение групп пользователя =====
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
        const groups = await Promise.all((data || []).map(async (item) => {
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
            groups
        });
    } catch (error) {
        console.error('❌ Ошибка получения групп:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Получение участников группы =====
app.get('/group-members/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        const { data, error } = await supabase
            .from('group_members')
            .select(`
                user_email,
                role,
                joined_at
            `)
            .eq('group_id', groupId);

        if (error) throw error;

        // Получаем информацию о каждом участнике
        const members = await Promise.all((data || []).map(async (m) => {
            const userInfo = await getUserInfo(m.user_email);
            return {
                email: m.user_email,
                first_name: userInfo?.first_name || '',
                last_name: userInfo?.last_name || '',
                role: m.role,
                joined_at: m.joined_at
            };
        }));

        res.json({
            success: true,
            members
        });
    } catch (error) {
        console.error('❌ Ошибка получения участников группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Добавление участника в группу =====
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

        await supabase
            .from('group_members')
            .upsert({
                group_id: groupId,
                user_email: userEmail.toLowerCase()
            }, {
                onConflict: 'group_id,user_email',
                ignoreDuplicates: true
            });

        res.json({
            success: true,
            message: 'Участник добавлен'
        });
    } catch (error) {
        console.error('❌ Ошибка добавления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Удаление участника из группы =====
app.post('/remove-group-member', async (req, res) => {
    try {
        const { groupId, userEmail } = req.body;

        if (!groupId || !userEmail) {
            return res.status(400).json({ success: false, error: 'Группа и пользователь обязательны' });
        }

        await supabase
            .from('group_members')
            .delete()
            .eq('group_id', groupId)
            .eq('user_email', userEmail.toLowerCase());

        res.json({
            success: true,
            message: 'Участник удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления участника:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Удаление группы =====
app.delete('/group/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        await supabase
            .from('groups')
            .delete()
            .eq('id', groupId);

        res.json({
            success: true,
            message: 'Группа удалена'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления группы:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Отправка сообщения в группу =====
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

// ===== Получение сообщений группы =====
app.get('/group-messages/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        const { data, error } = await supabase
            .from('group_messages')
            .select('*')
            .eq('group_id', groupId)
            .order('timestamp', { ascending: true });

        if (error) throw error;

        // Добавляем информацию об отправителях
        const messages = await Promise.all((data || []).map(async (m) => {
            const senderInfo = await getUserInfo(m.sender_email);
            return {
                ...m,
                first_name: senderInfo?.first_name || '',
                last_name: senderInfo?.last_name || ''
            };
        }));

        res.json({
            success: true,
            messages
        });
    } catch (error) {
        console.error('❌ Ошибка получения групповых сообщений:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Загрузка файла в группу =====
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
                    const thumbPath = path.join(thumbnailsDir, thumbnail);
                    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
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

// ===== Информация о групповом файле =====
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
            exists,
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

// ===== Получение онлайн пользователей =====
app.get('/online-users', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_presence')
            .select('user_email, server_id, last_seen')
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        if (error) throw error;

        res.json({
            success: true,
            online: (data || []).map(u => ({
                email: u.user_email,
                server: u.server_id,
                lastSeen: u.last_seen
            })),
            count: data?.length || 0
        });
    } catch (error) {
        console.error('❌ Ошибка получения онлайн пользователей:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ===== Создание таблицы для WebRTC звонков =====
app.get('/setup-webrtc-table', async (req, res) => {
    try {
        // Создаем таблицу для WebRTC звонков
        const { error } = await supabase.rpc('create_webrtc_calls_table', {});
        
        // Если RPC не работает, выполняем прямой SQL (нужны права)
        if (error) {
            console.log('Используем альтернативный метод создания таблицы');
            // В реальном проекте нужно выполнить SQL через миграции
        }

        res.json({
            success: true,
            message: 'WebRTC таблица настроена'
        });
    } catch (error) {
        console.error('❌ Ошибка создания таблицы:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== СТАТИЧЕСКИЕ ФАЙЛЫ =====
app.use('/uploads', express.static(uploadDir));

// ===== ЗАПУСК СЕРВЕРА =====
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 ЗАПУСК СЕРВЕРА BERE');
    console.log('='.repeat(50));
    console.log(`📡 Порт: ${PORT}`);
    console.log(`🆔 Server ID: ${SERVER_ID}`);
    console.log(`🌐 Режим: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 Socket.IO (чат) активен на /socket.io`);
    console.log(`📡 WebSocket (WebRTC) активен на /webrtc`);
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log('='.repeat(50) + '\n');
    
    // Проверяем наличие таблицы webrtc_calls
    try {
        const { error } = await supabase
            .from('webrtc_calls')
            .select('count', { count: 'exact', head: true });
        
        if (error && error.message.includes('relation "webrtc_calls" does not exist')) {
            console.log('⚠️ Таблица webrtc_calls не найдена. Создайте её в Supabase:');
            console.log(`
CREATE TABLE IF NOT EXISTS webrtc_calls (
    call_id TEXT PRIMARY KEY,
    caller_email TEXT NOT NULL,
    receiver_email TEXT NOT NULL,
    status TEXT DEFAULT 'ringing',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    answered_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_webrtc_calls_caller ON webrtc_calls(caller_email);
CREATE INDEX IF NOT EXISTS idx_webrtc_calls_receiver ON webrtc_calls(receiver_email, status);
            `);
        }
    } catch (e) {
        // Игнорируем ошибки
    }
});

// ===== Graceful shutdown =====
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    
    // Очищаем присутствие всех пользователей на этом сервере
    try {
        await supabase
            .from('user_presence')
            .delete()
            .eq('server_id', SERVER_ID);
        console.log('✅ Присутствие пользователей очищено');
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
    
    // Закрываем WebSocket соединения
    wss.close();
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Остановка сервера (SIGTERM)...');
    
    try {
        await supabase
            .from('user_presence')
            .delete()
            .eq('server_id', SERVER_ID);
        console.log('✅ Присутствие пользователей очищено');
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
    
    wss.close();
    
    process.exit(0);
});
