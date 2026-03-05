// server.js - Объединенный сервер чата и звонков с FCM поддержкой
// ==================== ИМПОРТЫ ====================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
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
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');

// ==================== КОНФИГУРАЦИЯ ====================
const isRender = process.env.NODE_ENV === 'production';
const SERVER_ID = process.env.RENDER_SERVICE_ID || `server-${Math.random().toString(36).substring(2, 10)}`;

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ==================== SOCKET.IO ====================
const io = socketIo(server, {
    cors: {
        origin: isRender ? ["https://beresta-server-5udn.onrender.com"] : "*",
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ==================== FIREBASE ADMIN ====================
// Загружаем сервисный аккаунт из файла
// Имя файла может быть разным, поэтому используем переменную окружения
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './beresta-9ed83-firebase-adminsdk-fbsvc-a14e896462.json';

let serviceAccount;
try {
  // Пытаемся загрузить файл сервисного аккаунта
  serviceAccount = require(FIREBASE_SERVICE_ACCOUNT_PATH);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin инициализирован успешно');
  console.log(`📁 Используется файл: ${FIREBASE_SERVICE_ACCOUNT_PATH}`);
  console.log(`🔥 Проект: ${serviceAccount.project_id}`);
} catch (error) {
  console.error('❌ Ошибка инициализации Firebase Admin:', error.message);
  console.log('⚠️ FCM уведомления не будут работать без файла сервисного аккаунта');
  console.log('📁 Ожидается файл: beresta-9ed83-firebase-adminsdk-fbsvc-a14e896462.json');
  console.log('💡 Вы можете указать другой файл через переменную окружения FIREBASE_SERVICE_ACCOUNT_PATH');
}

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ==================== ХРАНИЛИЩА ДАННЫХ ====================
const rooms = new Map();           // Комнаты и их участники
const roomsInfo = new Map();       // Информация о комнатах
const users = new Map();           // Информация о пользователях
const callHistory = new Map();     // История звонков
const activeCalls = new Map();     // Активные звонки
const emailToSocket = new Map();   // Маппинг email -> socket.id
const socketToEmail = new Map();   // Обратный маппинг

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

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

async function getUserInfo(email) {
    const normalizedEmail = email.toLowerCase();
    
    const { data: regularUser, error: regularError } = await supabase
        .from('regular_users')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();

    if (regularUser) {
        return { ...regularUser, userType: 'regular' };
    }

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

async function userExists(email) {
    const user = await getUserInfo(email);
    return user !== null;
}

async function addToChatsAutomatically(user1, user2) {
    try {
        const user1Email = user1.toLowerCase();
        const user2Email = user2.toLowerCase();

        await supabase
            .from('friends')
            .upsert({ 
                user_email: user1Email, 
                friend_email: user2Email 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

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

async function cleanupOldPresence() {
    try {
        const { error } = await supabase
            .from('user_presence')
            .delete()
            .lt('last_seen', new Date(Date.now() - 60000).toISOString());

        if (error) throw error;
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
}

setInterval(cleanupOldPresence, 60000);

function calculateDuration(startTime) {
    const start = new Date(startTime);
    const now = new Date();
    const diff = Math.floor((now - start) / 1000);
    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return minutes + ':' + (seconds < 10 ? '0' + seconds : seconds);
}

function getTodayCallsCount() {
    const today = new Date().toDateString();
    let count = 0;
    for (const [_, call] of callHistory) {
        if (new Date(call.startTime || call.startedAt).toDateString() === today) {
            count++;
        }
    }
    return count;
}

// ==================== ФУНКЦИИ ДЛЯ FCM ====================

async function sendFCMNotification(userEmail, title, body, data) {
    if (!admin.apps.length) {
        console.log('❌ Firebase не инициализирован');
        return false;
    }

    try {
        // Получаем FCM токен пользователя из базы данных
        const { data: userData, error } = await supabase
            .from('user_fcm_tokens')
            .select('fcm_token')
            .eq('user_email', userEmail.toLowerCase())
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) throw error;

        if (!userData || userData.length === 0 || !userData[0].fcm_token) {
            console.log(`❌ Нет FCM токена для ${userEmail}`);
            return false;
        }

        const message = {
            notification: {
                title: title,
                body: body,
            },
            data: {
                ...data,
                click_action: 'OPEN_CALL_ACTIVITY'
            },
            token: userData[0].fcm_token,
            android: {
                priority: 'high',
                notification: {
                    channelId: 'calls',
                    priority: 'high',
                    visibility: 'public',
                    clickAction: 'OPEN_CALL_ACTIVITY'
                },
            },
        };

        const response = await admin.messaging().send(message);
        console.log(`✅ FCM уведомление отправлено: ${response}`);
        return true;
    } catch (error) {
        console.error('❌ Ошибка отправки FCM:', error);
        return false;
    }
}

// ==================== SOCKET.IO ОБРАБОТЧИКИ ====================
io.on('connection', (socket) => {
    console.log('👤 Пользователь подключился:', socket.id);
    
    users.set(socket.id, {
        connectedAt: new Date().toISOString(),
        socketId: socket.id
    });

    socket.on('user_online', async (data) => {
        try {
            if (data && data.email) {
                const email = data.email.toLowerCase();
                socket.userEmail = email;
                
                emailToSocket.set(email, socket.id);
                socketToEmail.set(socket.id, email);
                
                console.log(`📧 Маппинг: ${email} -> ${socket.id}`);
                
                await updateUserPresence(email, socket.id, 'online');
                
                console.log(`👤 Пользователь онлайн: ${email} на сервере ${SERVER_ID}`);
                
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

    socket.on('ping', (data) => {
        socket.emit('pong', {
            ...data,
            serverTime: new Date().toISOString()
        });
    });

    socket.on('join-room', (data) => {
        const roomId = data.roomId;
        const userInfo = data.userInfo || {};
        
        console.log('📢 ' + socket.id + ' подключается к комнате звонка: ' + roomId);
        
        if (userInfo.email) {
            emailToSocket.set(userInfo.email, socket.id);
            socketToEmail.set(socket.id, userInfo.email);
        }
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
        }
        
        const room = rooms.get(roomId);
        
        if (room.size >= 2) {
            console.log('❌ Комната ' + roomId + ' переполнена');
            socket.emit('room-full');
            return;
        }
        
        room.add(socket.id);
        socket.join(roomId);
        
        const userData = users.get(socket.id) || {};
        users.set(socket.id, { ...userData, ...userInfo, roomId, joinedAt: new Date().toISOString() });
        
        if (!roomsInfo.has(roomId)) {
            roomsInfo.set(roomId, {
                name: roomId,
                createdAt: new Date().toISOString(),
                createdBy: socket.id,
                type: userInfo?.type || 'video'
            });
        }
        
        console.log('✅ ' + socket.id + ' подключился к ' + roomId + '. Участников: ' + room.size);
        
        socket.emit('join-success', { roomId: roomId, participants: Array.from(room) });
        
        if (room.size > 1) {
            io.to(roomId).emit('peer-joined', socket.id);
        }
        
        io.emit('rooms-updated');
    });

    socket.on('offer', (data) => {
        console.log('📤 Оффер от ' + socket.id + ' к ' + data.target);
        
        let targetSocketId = data.target;
        
        if (typeof data.target === 'string' && data.target.includes('@')) {
            targetSocketId = emailToSocket.get(data.target);
        }
        
        if (targetSocketId) {
            socket.to(targetSocketId).emit('offer', {
                offer: data.offer,
                sender: socket.id
            });
        }
    });

    socket.on('answer', (data) => {
        console.log('📤 Ответ от ' + socket.id + ' к ' + data.target);
        
        let targetSocketId = data.target;
        
        if (typeof data.target === 'string' && data.target.includes('@')) {
            targetSocketId = emailToSocket.get(data.target);
        }
        
        if (targetSocketId) {
            socket.to(targetSocketId).emit('answer', {
                answer: data.answer,
                sender: socket.id
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        console.log('📤 ICE кандидат от ' + socket.id + ' к ' + data.target);
        
        let targetSocketId = data.target;
        
        if (typeof data.target === 'string' && data.target.includes('@')) {
            targetSocketId = emailToSocket.get(data.target);
        }
        
        if (targetSocketId) {
            socket.to(targetSocketId).emit('ice-candidate', {
                candidate: data.candidate,
                sender: socket.id
            });
        }
    });

    socket.on('leave-room', (roomId) => {
        handleDisconnect(socket, roomId);
    });

    socket.on('disconnect', async (reason) => {
        console.log(`❌ WebSocket отключен: ${socket.id}, причина: ${reason}`);
        
        const email = socketToEmail.get(socket.id);
        if (email) {
            emailToSocket.delete(email);
            socketToEmail.delete(socket.id);
            console.log(`📧 Удален маппинг для ${email}`);
        }
        
        handleDisconnect(socket);
        
        if (socket.userEmail) {
            await updateUserPresence(socket.userEmail, socket.id, 'offline');
            
            socket.broadcast.emit('user_status_changed', {
                email: socket.userEmail,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        }
    });

    socket.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
});

function handleDisconnect(socket, specificRoom = null) {
    let roomId = specificRoom;
    
    if (!roomId) {
        for (const [rId, members] of rooms.entries()) {
            if (members.has(socket.id)) {
                roomId = rId;
                break;
            }
        }
    }
    
    if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        room.delete(socket.id);
        
        io.to(roomId).emit('peer-disconnected');
        
        if (room.size === 0) {
            rooms.delete(roomId);
            roomsInfo.delete(roomId);
        }
        
        console.log('👋 ' + socket.id + ' покинул комнату ' + roomId);
    }
    
    users.delete(socket.id);
    io.emit('rooms-updated');
}

// ==================== API ЭНДПОИНТЫ ====================

app.get('/health', async (req, res) => {
    try {
        const { error } = await supabase.from('regular_users').select('count', { count: 'exact', head: true });
        
        if (error) throw error;
        
        const { count } = await supabase
            .from('user_presence')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        const dirs = [uploadDir, tempDir, permanentDir, thumbnailsDir];
        const dirStatus = {};
        dirs.forEach(dir => {
            dirStatus[path.basename(dir)] = fs.existsSync(dir);
        });

        res.json({
            success: true,
            status: 'Server is running optimally',
            serverId: SERVER_ID,
            stats: {
                activeRooms: rooms.size,
                totalUsers: users.size,
                activeCalls: activeCalls.size,
                onlineUsers: count || 0,
                totalCallsToday: getTodayCallsCount()
            },
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

// ===== ЭНДПОИНТЫ ДЛЯ ЗВОНКОВ =====

/**
 * Инициирование звонка с FCM уведомлением
 */
app.post('/api/calls/initiate', async (req, res) => {
    try {
        const { callerEmail, receiverEmail, callType } = req.body;
        
        if (!callerEmail || !receiverEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email звонящего и получателя обязательны'
            });
        }
        
        console.log(`📞 Инициирование звонка: ${callerEmail} -> ${receiverEmail}`);
        
        // Проверяем, что получатель не равен отправителю
        if (callerEmail.toLowerCase() === receiverEmail.toLowerCase()) {
            return res.status(400).json({
                success: false,
                error: 'Нельзя позвонить самому себе'
            });
        }
        
        // Генерируем уникальный ID комнаты
        const roomId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        
        // Создаем запись о звонке
        const callData = {
            roomId,
            caller: callerEmail,
            receiver: receiverEmail,
            type: callType || 'audio',
            status: 'ringing',
            startedAt: new Date().toISOString(),
            participants: [callerEmail]
        };
        
        activeCalls.set(roomId, callData);
        
        // Отправляем FCM уведомление получателю
        const fcmSent = await sendFCMNotification(
            receiverEmail,
            '📞 Входящий звонок',
            `${callerEmail} (${callType === 'video' ? 'видео' : 'аудио'})`,
            {
                type: 'call',
                roomId: roomId,
                caller: callerEmail,
                callType: callType || 'audio',
                userEmail: receiverEmail
            }
        );
        
        console.log(`📱 FCM уведомление ${fcmSent ? 'отправлено' : 'не отправлено'}`);
        
        // Отправляем через Socket.IO для онлайн пользователей
        const receiverSocketId = emailToSocket.get(receiverEmail);
        if (receiverSocketId) {
            console.log(`📱 Получатель онлайн, socketId: ${receiverSocketId}`);
            
            io.to(receiverSocketId).emit('incoming-call', {
                type: 'incoming-call',
                roomId: roomId,
                caller: callerEmail,
                callType: callType || 'audio',
                timestamp: new Date().toISOString()
            });
            
            io.to(receiverSocketId).emit(`call:${receiverEmail}`, {
                type: 'incoming-call',
                roomId: roomId,
                caller: callerEmail,
                callType: callType || 'audio',
                timestamp: new Date().toISOString()
            });
        }
        
        console.log(`✅ Звонок инициирован, комната: ${roomId}`);
        
        res.json({
            success: true,
            roomId: roomId,
            message: 'Звонок инициирован',
            isReceiverOnline: !!receiverSocketId,
            fcmSent: fcmSent
        });
        
    } catch (error) {
        console.error('❌ Ошибка инициации звонка:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Принять звонок
 */
app.post('/api/calls/accept', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId || !userEmail) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты и email обязательны'
            });
        }
        
        const callData = activeCalls.get(roomId);
        
        if (!callData) {
            return res.status(404).json({
                success: false,
                error: 'Звонок не найден'
            });
        }
        
        if (callData.receiver !== userEmail) {
            return res.status(403).json({
                success: false,
                error: 'Вы не можете принять этот звонок'
            });
        }
        
        callData.status = 'connected';
        callData.participants.push(userEmail);
        callData.answeredAt = new Date().toISOString();
        activeCalls.set(roomId, callData);
        
        const callerSocketId = emailToSocket.get(callData.caller);
        
        if (callerSocketId) {
            io.to(callerSocketId).emit('call-accepted', {
                type: 'call-accepted',
                roomId: roomId,
                receiver: userEmail,
                timestamp: new Date().toISOString()
            });
        }
        
        console.log(`✅ Звонок ${roomId} принят пользователем ${userEmail}`);
        
        res.json({
            success: true,
            roomId: roomId,
            callData: callData
        });
        
    } catch (error) {
        console.error('❌ Ошибка принятия звонка:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Отклонить звонок
 */
app.post('/api/calls/reject', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId || !userEmail) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты и email обязательны'
            });
        }
        
        const callData = activeCalls.get(roomId);
        
        if (callData) {
            const callerSocketId = emailToSocket.get(callData.caller);
            
            if (callerSocketId) {
                io.to(callerSocketId).emit('call-rejected', {
                    type: 'call-rejected',
                    roomId: roomId,
                    receiver: userEmail,
                    timestamp: new Date().toISOString()
                });
            }
            
            activeCalls.delete(roomId);
        }
        
        console.log(`❌ Звонок ${roomId} отклонен пользователем ${userEmail}`);
        
        res.json({
            success: true,
            message: 'Звонок отклонен'
        });
        
    } catch (error) {
        console.error('❌ Ошибка отклонения звонка:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Завершить звонок
 */
app.post('/api/calls/end', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты обязателен'
            });
        }
        
        const callData = activeCalls.get(roomId);
        
        if (callData) {
            callData.participants.forEach(email => {
                if (email !== userEmail) {
                    const participantSocketId = emailToSocket.get(email);
                    if (participantSocketId) {
                        io.to(participantSocketId).emit('call-ended', {
                            type: 'call-ended',
                            roomId: roomId,
                            endedBy: userEmail,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            });
            
            const endedCall = {
                ...callData,
                endedBy: userEmail || 'system',
                endTime: new Date().toISOString(),
                status: 'ended',
                duration: calculateDuration(callData.startedAt)
            };
            
            const historyId = 'hist_' + Date.now();
            callHistory.set(historyId, endedCall);
            
            activeCalls.delete(roomId);
        }
        
        console.log(`📴 Звонок ${roomId} завершен пользователем ${userEmail || 'system'}`);
        
        res.json({
            success: true,
            message: 'Звонок завершен'
        });
        
    } catch (error) {
        console.error('❌ Ошибка завершения звонка:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Получить информацию о звонке
 */
app.get('/api/calls/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const callData = activeCalls.get(roomId);
        
        if (!callData) {
            return res.status(404).json({
                success: false,
                error: 'Звонок не найден'
            });
        }
        
        res.json({
            success: true,
            call: callData
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения информации о звонке:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Получить активные звонки пользователя
 */
app.get('/api/calls/user/:email', async (req, res) => {
    try {
        const { email } = req.params;
        
        const userCalls = [];
        
        for (const [roomId, callData] of activeCalls.entries()) {
            if (callData.caller === email || callData.receiver === email || 
                (callData.participants && callData.participants.includes(email))) {
                userCalls.push({
                    roomId,
                    ...callData
                });
            }
        }
        
        res.json({
            success: true,
            calls: userCalls
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения звонков пользователя:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== FCM ЭНДПОИНТЫ =====

/**
 * Сохранить FCM токен пользователя
 */
app.post('/api/fcm/token', async (req, res) => {
    try {
        const { userEmail, fcmToken } = req.body;
        
        if (!userEmail || !fcmToken) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email и токен обязательны' 
            });
        }

        const { error } = await supabase
            .from('user_fcm_tokens')
            .upsert({
                user_email: userEmail.toLowerCase(),
                fcm_token: fcmToken,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'user_email,fcm_token'
            });

        if (error) throw error;

        console.log(`✅ FCM токен сохранен для ${userEmail}`);
        
        res.json({ 
            success: true,
            message: 'FCM токен сохранен'
        });
    } catch (error) {
        console.error('❌ Ошибка сохранения FCM токена:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Тестовый эндпоинт для отправки FCM уведомления
 */
app.post('/api/fcm/test', async (req, res) => {
    try {
        const { userEmail, title, body } = req.body;
        
        if (!userEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email обязателен' 
            });
        }

        const result = await sendFCMNotification(
            userEmail,
            title || 'Тестовое уведомление',
            body || 'Это тестовое уведомление из Beresta',
            { type: 'test' }
        );

        res.json({ 
            success: true,
            sent: result
        });
    } catch (error) {
        console.error('❌ Ошибка тестовой отправки FCM:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ===== РЕГИСТРАЦИЯ И ПОЛЬЗОВАТЕЛИ =====
// ... (все остальные эндпоинты остаются без изменений)

// ===== ДЕБАГ ЭНДПОИНТЫ =====
app.get('/api/debug/mappings', (req, res) => {
    res.json({
        success: true,
        emailToSocket: Array.from(emailToSocket.entries()),
        socketToEmail: Array.from(socketToEmail.entries()),
        activeCalls: Array.from(activeCalls.entries()).map(([id, data]) => ({
            id,
            caller: data.caller,
            receiver: data.receiver,
            status: data.status
        }))
    });
});

// ===== ЗАПУСК СЕРВЕРА =====
server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 ЗАПУСК ОБЪЕДИНЕННОГО СЕРВЕРА BERESTA');
    console.log('='.repeat(60));
    console.log(`📡 Порт: ${PORT}`);
    console.log(`🆔 Server ID: ${SERVER_ID}`);
    console.log(`🌐 Режим: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 Веб-интерфейс: http://localhost:${PORT}`);
    console.log(`🔌 API Endpoint: http://localhost:${PORT}/api`);
    console.log(`📡 Socket.IO активен на /socket.io`);
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log(`📧 Маппинг email->socketId активен`);
    console.log(`🔥 FCM уведомления: ${admin.apps.length ? 'активны' : 'не настроены'}`);
    console.log('='.repeat(60) + '\n');
});

// ===== Graceful shutdown =====
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    
    try {
        await supabase
            .from('user_presence')
            .delete()
            .eq('server_id', SERVER_ID);
        console.log('✅ Присутствие пользователей очищено');
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
    
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
    
    process.exit(0);
});
