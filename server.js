// server.js - Объединенный сервер чата и звонков
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
const Agora = require('agora-access-token');

// ==================== КОНФИГУРАЦИЯ ====================
const isRender = process.env.NODE_ENV === 'production';
const SERVER_ID = process.env.RENDER_SERVICE_ID || `server-${Math.random().toString(36).substring(2, 10)}`;

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ==================== SOCKET.IO (для чата и звонков) ====================
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
const roomsInfo = new Map();       // Информация о комнатах (название, создатель и т.д.)
const users = new Map();           // Информация о пользователях
const callHistory = new Map();     // История звонков
const activeCalls = new Map();     // Активные звонки

// Периодическая очистка старых звонков (раз в 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [roomId, callData] of activeCalls.entries()) {
        // Удаляем звонки старше 1 часа
        const startedAt = new Date(callData.startedAt || callData.startTime).getTime();
        if (now - startedAt > 60 * 60 * 1000) {
            activeCalls.delete(roomId);
            console.log(`🧹 Очищен старый звонок: ${roomId}`);
        }
    }
}, 5 * 60 * 1000);

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

// Запускаем очистку раз в минуту
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

// ==================== SOCKET.IO ОБРАБОТЧИКИ ====================
io.on('connection', (socket) => {
    console.log('👤 Пользователь подключился:', socket.id);
    
    users.set(socket.id, {
        connectedAt: new Date().toISOString(),
        socketId: socket.id
    });

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

    // Обработчик подключения к комнате звонка
    socket.on('join-room', (data) => {
        const roomId = data.roomId;
        const userInfo = data.userInfo || {};
        
        console.log('📢 ' + socket.id + ' подключается к комнате звонка: ' + roomId);
        
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

    // Обработчики WebRTC сигнализации
    socket.on('offer', (data) => {
        console.log('📤 Оффер от ' + socket.id + ' к ' + data.target);
        socket.to(data.target).emit('offer', {
            offer: data.offer,
            sender: socket.id
        });
    });

    socket.on('answer', (data) => {
        console.log('📤 Ответ от ' + socket.id + ' к ' + data.target);
        socket.to(data.target).emit('answer', {
            answer: data.answer,
            sender: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        console.log('📤 ICE кандидат от ' + socket.id + ' к ' + data.target);
        socket.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    socket.on('leave-room', (roomId) => {
        handleDisconnect(socket, roomId);
    });

    // Обработчик отключения
    socket.on('disconnect', async (reason) => {
        console.log(`❌ WebSocket отключен: ${socket.id}, причина: ${reason}`);
        
        handleDisconnect(socket);
        
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
        
        // Если в комнате никого не осталось, удаляем информацию о ней
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

// ===== Статус сервера =====
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        serverId: SERVER_ID,
        stats: {
            activeRooms: rooms.size,
            totalUsers: users.size,
            activeCalls: activeCalls.size,
            totalCallsToday: getTodayCallsCount()
        }
    });
});

// ===== Список всех комнат =====
app.get('/api/rooms', (req, res) => {
    const roomsList = [];
    for (const [roomId, participants] of rooms.entries()) {
        roomsList.push({
            roomId: roomId,
            participants: participants.size,
            participantsList: Array.from(participants).map(socketId => ({
                socketId,
                userInfo: users.get(socketId) || { name: 'Аноним', type: 'unknown' }
            })),
            roomInfo: roomsInfo.get(roomId) || {
                name: roomId,
                createdAt: new Date().toISOString()
            }
        });
    }
    res.json({
        total: roomsList.length,
        rooms: roomsList
    });
});

// ===== Информация о конкретной комнате =====
app.get('/api/rooms/:roomId', (req, res) => {
    const { roomId } = req.params;
    const participants = rooms.get(roomId);
    
    if (!participants) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }
    
    res.json({
        roomId,
        participants: participants.size,
        participantsList: Array.from(participants).map(socketId => ({
            socketId,
            userInfo: users.get(socketId) || { name: 'Аноним', type: 'unknown' }
        })),
        roomInfo: roomsInfo.get(roomId) || {
            name: roomId,
            createdAt: new Date().toISOString()
        }
    });
});

// ===== Создать комнату (через API) =====
app.post('/api/rooms', (req, res) => {
    const { roomId, roomName, createdBy, type = 'video' } = req.body;
    
    if (!roomId) {
        return res.status(400).json({ error: 'roomId обязателен' });
    }
    
    if (rooms.has(roomId)) {
        return res.status(409).json({ error: 'Комната уже существует' });
    }
    
    rooms.set(roomId, new Set());
    roomsInfo.set(roomId, {
        name: roomName || roomId,
        createdBy: createdBy || 'system',
        createdAt: new Date().toISOString(),
        type: type,
        settings: req.body.settings || {}
    });
    
    res.status(201).json({
        success: true,
        roomId,
        message: 'Комната создана',
        roomInfo: roomsInfo.get(roomId)
    });
});

// ===== Обновить информацию о комнате =====
app.put('/api/rooms/:roomId', (req, res) => {
    const { roomId } = req.params;
    const updates = req.body;
    
    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }
    
    const currentInfo = roomsInfo.get(roomId) || {};
    roomsInfo.set(roomId, { ...currentInfo, ...updates, updatedAt: new Date().toISOString() });
    
    io.to(roomId).emit('room-updated', roomsInfo.get(roomId));
    
    res.json({
        success: true,
        roomId,
        roomInfo: roomsInfo.get(roomId)
    });
});

// ===== Удалить комнату =====
app.delete('/api/rooms/:roomId', (req, res) => {
    const { roomId } = req.params;
    
    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }
    
    io.to(roomId).emit('room-closed', { roomId, reason: 'Комната закрыта администратором' });
    
    rooms.delete(roomId);
    roomsInfo.delete(roomId);
    
    res.json({
        success: true,
        message: 'Комната удалена'
    });
});

// ===== Информация о пользователе по socketId =====
app.get('/api/users/:socketId', (req, res) => {
    const { socketId } = req.params;
    const userInfo = users.get(socketId);
    
    if (!userInfo) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json(userInfo);
});

// ===== Обновить информацию о пользователе =====
app.put('/api/users/:socketId', (req, res) => {
    const { socketId } = req.params;
    const updates = req.body;
    
    const currentInfo = users.get(socketId) || {};
    users.set(socketId, { ...currentInfo, ...updates, updatedAt: new Date().toISOString() });
    
    res.json({
        success: true,
        userInfo: users.get(socketId)
    });
});

// ===== История звонков =====
app.get('/api/calls/history', (req, res) => {
    const { limit = 50, roomId } = req.query;
    let history = Array.from(callHistory.values());
    
    if (roomId) {
        history = history.filter(call => call.roomId === roomId);
    }
    
    history.sort((a, b) => new Date(b.startTime || b.startedAt) - new Date(a.startTime || a.startedAt));
    history = history.slice(0, parseInt(limit));
    
    res.json({
        total: history.length,
        calls: history
    });
});

// ===== Активные звонки =====
app.get('/api/calls/active', (req, res) => {
    const active = Array.from(activeCalls.values());
    res.json({
        total: active.length,
        calls: active
    });
});

// ===== Инициировать звонок через API =====
app.post('/api/calls/start', (req, res) => {
    const { roomId, callerId, calleeId, type = 'video' } = req.body;
    
    if (!roomId || !callerId) {
        return res.status(400).json({ error: 'roomId и callerId обязательны' });
    }
    
    const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const callInfo = {
        callId,
        roomId,
        callerId,
        calleeId: calleeId || null,
        type,
        startTime: new Date().toISOString(),
        status: 'initiated',
        participants: [callerId]
    };
    
    activeCalls.set(callId, callInfo);
    
    if (calleeId) {
        io.to(calleeId).emit('incoming-call', callInfo);
    }
    
    res.status(201).json(callInfo);
});

// ===== Завершить звонок через API =====
app.post('/api/calls/end/:callId', (req, res) => {
    const { callId } = req.params;
    const { endedBy } = req.body;
    
    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Звонок не найден' });
    }
    
    const endedCall = {
        ...call,
        endedBy: endedBy || 'system',
        endTime: new Date().toISOString(),
        status: 'ended',
        duration: calculateDuration(call.startTime || call.startedAt)
    };
    
    activeCalls.delete(callId);
    
    const historyId = 'hist_' + Date.now();
    callHistory.set(historyId, endedCall);
    
    if (call.participants) {
        call.participants.forEach(participantId => {
            io.to(participantId).emit('call-ended', endedCall);
        });
    }
    
    res.json(endedCall);
});

// ===== Статистика =====
app.get('/api/stats', (req, res) => {
    const stats = {
        timestamp: new Date().toISOString(),
        server: {
            id: SERVER_ID,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            nodeVersion: process.version
        },
        rooms: {
            total: rooms.size,
            details: Array.from(rooms.entries()).map(([id, participants]) => ({
                id,
                participants: participants.size
            }))
        },
        users: {
            total: users.size,
            online: io.engine.clientsCount
        },
        calls: {
            active: activeCalls.size,
            totalToday: getTodayCallsCount()
        }
    };
    
    res.json(stats);
});

// ===== Webhook для внешних сервисов =====
app.post('/api/webhook/:event', (req, res) => {
    const { event } = req.params;
    const data = req.body;
    
    console.log('📡 Webhook получен: ' + event, data);
    
    res.json({
        success: true,
        event,
        received: data,
        timestamp: new Date().toISOString()
    });
});

// ===== НОВЫЕ ЭНДПОИНТЫ ДЛЯ ЗВОНКОВ (ПРОСТАЯ РЕАЛИЗАЦИЯ) =====

/**
 * Инициирование звонка (простая версия)
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
        
        // Сохраняем в Map
        activeCalls.set(roomId, callData);
        
        // Отправляем уведомление получателю через Socket.IO
        io.emit(`call:${receiverEmail}`, {
            type: 'incoming-call',
            roomId: roomId,
            caller: callerEmail,
            callType: callType || 'audio',
            timestamp: new Date().toISOString()
        });
        
        console.log(`✅ Звонок инициирован, комната: ${roomId}`);
        
        res.json({
            success: true,
            roomId: roomId,
            message: 'Звонок инициирован'
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
        
        // Получаем информацию о звонке
        const callData = activeCalls.get(roomId);
        
        if (!callData) {
            return res.status(404).json({
                success: false,
                error: 'Звонок не найден'
            });
        }
        
        // Проверяем, что принимает именно тот, кому звонят
        if (callData.receiver !== userEmail) {
            return res.status(403).json({
                success: false,
                error: 'Вы не можете принять этот звонок'
            });
        }
        
        // Обновляем статус
        callData.status = 'connected';
        callData.participants.push(userEmail);
        callData.answeredAt = new Date().toISOString();
        activeCalls.set(roomId, callData);
        
        // Уведомляем звонящего, что звонок принят
        io.emit(`call:${callData.caller}`, {
            type: 'call-accepted',
            roomId: roomId,
            receiver: userEmail,
            timestamp: new Date().toISOString()
        });
        
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
            // Уведомляем звонящего об отказе
            io.emit(`call:${callData.caller}`, {
                type: 'call-rejected',
                roomId: roomId,
                receiver: userEmail,
                timestamp: new Date().toISOString()
            });
            
            // Удаляем звонок
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
            // Уведомляем всех участников о завершении
            callData.participants.forEach(email => {
                if (email !== userEmail) {
                    io.emit(`call:${email}`, {
                        type: 'call-ended',
                        roomId: roomId,
                        endedBy: userEmail,
                        timestamp: new Date().toISOString()
                    });
                }
            });
            
            // Сохраняем в историю
            const endedCall = {
                ...callData,
                endedBy: userEmail || 'system',
                endTime: new Date().toISOString(),
                status: 'ended',
                duration: calculateDuration(callData.startedAt)
            };
            
            const historyId = 'hist_' + Date.now();
            callHistory.set(historyId, endedCall);
            
            // Удаляем из активных
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

/**
 * Проверить, свободен ли пользователь (не в звонке)
 */
app.get('/api/calls/check-availability/:email', async (req, res) => {
    try {
        const { email } = req.params;
        
        let isInCall = false;
        
        for (const callData of activeCalls.values()) {
            if (callData.status === 'connected' && 
                (callData.caller === email || callData.receiver === email || 
                 (callData.participants && callData.participants.includes(email)))) {
                isInCall = true;
                break;
            }
        }
        
        res.json({
            success: true,
            email: email,
            available: !isInCall,
            inCall: isInCall
        });
        
    } catch (error) {
        console.error('❌ Ошибка проверки доступности:', error);
        res.status(500).json({
            success: false,
            error: error.message
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

// ===== СТАТИЧЕСКИЕ ФАЙЛЫ =====
app.use('/uploads', express.static(uploadDir));

// ===== ВЕБ-ИНТЕРФЕЙС =====
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Beresta - Чат и Видеозвонки</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 {
            text-align: center;
            color: white;
            margin-bottom: 30px;
            font-size: 2.5em;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }
        .main-panel {
            display: grid;
            grid-template-columns: 300px 1fr;
            gap: 20px;
        }
        .sidebar {
            background: white;
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        .sidebar h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.3em;
            border-bottom: 2px solid #f0f0f0;
            padding-bottom: 10px;
        }
        .user-info {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 20px;
        }
        .user-info input {
            width: 100%;
            padding: 10px;
            margin: 10px 0;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
        }
        .call-type-selector {
            display: flex;
            gap: 10px;
            margin: 15px 0;
        }
        .call-type-btn {
            flex: 1;
            padding: 10px;
            border: 2px solid #e0e0e0;
            background: white;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .call-type-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        .room-list {
            max-height: 300px;
            overflow-y: auto;
        }
        .room-item {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: all 0.3s;
            border-left: 4px solid #667eea;
        }
        .room-item:hover {
            transform: translateX(5px);
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .room-item .room-name { font-weight: 600; color: #333; }
        .room-item .room-type { font-size: 12px; color: #666; margin-top: 5px; }
        .room-item .participants { font-size: 12px; color: #48bb78; }
        .main-content {
            background: white;
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        .setup-section {
            background: #f8f9fa;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 30px;
        }
        .room-controls {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
        }
        .room-controls input,
        .room-controls select {
            padding: 15px 20px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 16px;
            flex: 1;
            min-width: 200px;
        }
        button {
            padding: 15px 30px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .btn-primary { background: #667eea; color: white; }
        .btn-success { background: #48bb78; color: white; }
        .btn-danger { background: #f56565; color: white; }
        .btn-warning { background: #ed8936; color: white; }
        .video-section { display: none; }
        .video-container {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            justify-content: center;
            margin-bottom: 20px;
        }
        .video-wrapper {
            flex: 1;
            min-width: 400px;
            position: relative;
        }
        .video-label {
            position: absolute;
            top: 10px;
            left: 10px;
            background: rgba(0,0,0,0.6);
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 14px;
            z-index: 1;
        }
        video {
            width: 100%;
            height: auto;
            border-radius: 15px;
            background: #2d3748;
            border: 3px solid #e2e8f0;
            aspect-ratio: 16/9;
            object-fit: cover;
        }
        .audio-only .video-wrapper video { display: none; }
        .audio-only .video-wrapper {
            background: #4a5568;
            border-radius: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 200px;
        }
        .audio-only .video-wrapper::before {
            content: "🎤 Аудио звонок";
            color: white;
            font-size: 24px;
        }
        .controls {
            display: flex;
            gap: 10px;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 20px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 15px;
        }
        .status-message {
            margin-top: 15px;
            padding: 10px;
            border-radius: 8px;
            text-align: center;
            font-weight: 500;
        }
        .success { background: #c6f6d5; color: #22543d; }
        .error { background: #fed7d7; color: #742a2a; }
        .info { background: #bee3f8; color: #2c5282; }
        .warning { background: #feebc8; color: #744210; }
        .loader {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            display: inline-block;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .hidden { display: none; }
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #f0f0f0;
            padding-bottom: 10px;
        }
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border-radius: 8px 8px 0 0;
            transition: all 0.3s;
        }
        .tab:hover { background: #f0f0f0; }
        .tab.active { background: #667eea; color: white; }
        .api-docs {
            background: #1a202c;
            color: #a0aec0;
            padding: 20px;
            border-radius: 10px;
            font-family: monospace;
            margin-top: 20px;
        }
        .api-docs h3 { color: white; margin-bottom: 15px; }
        .api-endpoint {
            margin: 10px 0;
            padding: 10px;
            background: #2d3748;
            border-radius: 5px;
        }
        .method {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-weight: bold;
            margin-right: 10px;
        }
        .method.get { background: #48bb78; color: white; }
        .method.post { background: #4299e1; color: white; }
        .method.put { background: #ed8936; color: white; }
        .method.delete { background: #f56565; color: white; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📹 Beresta - Чат и Видеозвонки</h1>
        
        <div class="main-panel">
            <div class="sidebar">
                <h2>👤 Пользователь</h2>
                <div class="user-info">
                    <input type="text" id="userName" placeholder="Ваше имя" value="Пользователь">
                    <div class="call-type-selector">
                        <button class="call-type-btn active" onclick="setCallType('video')" id="typeVideoBtn">📹 Видео</button>
                        <button class="call-type-btn" onclick="setCallType('audio')" id="typeAudioBtn">🎤 Аудио</button>
                    </div>
                </div>
                
                <h2>📋 Активные комнаты</h2>
                <div class="room-list" id="roomList">
                    <div class="room-item" onclick="joinRoomFromList('default')">
                        <div class="room-name">default</div>
                        <div class="room-type">📹 Видео комната</div>
                        <div class="participants">👥 0 участников</div>
                    </div>
                </div>
                
                <h2>📊 Статус</h2>
                <div id="sidebarStatus" class="status-message info">Подключение...</div>
                
                <h2>🔧 API</h2>
                <button onclick="showApiDocs()" class="btn-warning" style="width: 100%;">📚 Показать документацию API</button>
            </div>
            
            <div class="main-content">
                <div class="tabs">
                    <div class="tab active" onclick="switchTab('call')" id="tabCall">📞 Звонок</div>
                    <div class="tab" onclick="switchTab('api')" id="tabApi">🔌 API тестер</div>
                </div>
                
                <div id="callTab">
                    <div class="setup-section" id="setupSection">
                        <div class="room-controls">
                            <input type="text" id="roomInput" placeholder="Название комнаты" value="room1">
                            <select id="callTypeSelect">
                                <option value="video">📹 Видеозвонок</option>
                                <option value="audio">🎤 Аудиозвонок</option>
                            </select>
                            <button onclick="joinRoom()" class="btn-primary" id="joinBtn">
                                <span id="joinBtnText">🔗 Подключиться</span>
                                <span id="joinBtnLoader" class="loader hidden"></span>
                            </button>
                        </div>
                        <div id="setupStatus" class="status-message"></div>
                    </div>
                    
                    <div class="video-section" id="videoSection">
                        <div class="video-container" id="videoContainer">
                            <div class="video-wrapper">
                                <div class="video-label" id="localLabel">Вы</div>
                                <video id="localVideo" autoplay playsinline muted></video>
                            </div>
                            <div class="video-wrapper">
                                <div class="video-label" id="remoteLabel">Собеседник</div>
                                <video id="remoteVideo" autoplay playsinline></video>
                            </div>
                        </div>
                        
                        <div class="controls">
                            <button onclick="toggleAudio()" class="btn-success" id="audioBtn">🔊 Выключить микрофон</button>
                            <button onclick="toggleVideo()" class="btn-success" id="videoBtn" style="display: none;">📹 Выключить камеру</button>
                            <button onclick="testConnection()" class="btn-warning">🔧 Тест соединения</button>
                            <button onclick="hangUp()" class="btn-danger">📞 Завершить звонок</button>
                        </div>
                        
                        <div id="callStatus" class="status-message"></div>
                    </div>
                </div>
                
                <div id="apiTab" style="display: none;">
                    <h3>🔌 Тестирование API</h3>
                    
                    <div class="room-controls" style="margin-bottom: 20px;">
                        <select id="apiMethod">
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="DELETE">DELETE</option>
                        </select>
                        <input type="text" id="apiEndpoint" placeholder="/api/status" value="/api/status">
                        <button onclick="testApi()" class="btn-primary">Отправить</button>
                    </div>
                    
                    <div style="margin-bottom: 20px;">
                        <textarea id="apiBody" placeholder="JSON тело запроса (для POST/PUT)" rows="5" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #e0e0e0;"></textarea>
                    </div>
                    
                    <div id="apiResponse" style="background: #1a202c; color: #a0aec0; padding: 20px; border-radius: 10px; font-family: monospace; white-space: pre-wrap; min-height: 200px;">
                        Ответ появится здесь...
                    </div>
                    
                    <div class="api-docs" id="apiDocs" style="display: none;">
                        <h3>📚 Документация API</h3>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/status - Статус сервера</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/rooms - Список комнат</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/rooms/:roomId - Информация о комнате</div>
                        <div class="api-endpoint"><span class="method post">POST</span> /api/rooms - Создать комнату</div>
                        <div class="api-endpoint"><span class="method put">PUT</span> /api/rooms/:roomId - Обновить комнату</div>
                        <div class="api-endpoint"><span class="method delete">DELETE</span> /api/rooms/:roomId - Удалить комнату</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/users/:socketId - Информация о пользователе</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/calls/history - История звонков</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/calls/active - Активные звонки</div>
                        <div class="api-endpoint"><span class="method post">POST</span> /api/calls/start - Инициировать звонок</div>
                        <div class="api-endpoint"><span class="method post">POST</span> /api/calls/end/:callId - Завершить звонок</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /api/stats - Статистика сервера</div>
                        <div class="api-endpoint"><span class="method post">POST</span> /api/webhook/:event - Webhook для внешних сервисов</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /health - Health check</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /users - Список пользователей</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /user/:email - Информация о пользователе</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /chats/:userEmail - Чаты пользователя</div>
                        <div class="api-endpoint"><span class="method get">GET</span> /messages/:userEmail/:friendEmail - Сообщения</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io({
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });
        
        let localStream = null;
        let peerConnection = null;
        let currentRoom = null;
        let currentCallType = 'video';
        let isAudioEnabled = true;
        let isVideoEnabled = true;
        let userName = 'Пользователь';
        let mySocketId = null;
        
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10
        };
        
        function updateStatus(elementId, message, type) {
            const element = document.getElementById(elementId);
            if (element) {
                element.textContent = message;
                element.className = 'status-message ' + type;
            }
            console.log('[' + type + '] ' + message);
        }
        
        function setCallType(type) {
            currentCallType = type;
            document.getElementById('typeVideoBtn').classList.toggle('active', type === 'video');
            document.getElementById('typeAudioBtn').classList.toggle('active', type === 'audio');
            document.getElementById('callTypeSelect').value = type;
            document.getElementById('videoBtn').style.display = type === 'video' ? 'inline-block' : 'none';
            const container = document.getElementById('videoContainer');
            if (type === 'audio') {
                container.classList.add('audio-only');
            } else {
                container.classList.remove('audio-only');
            }
        }
        
        async function testApi() {
            const method = document.getElementById('apiMethod').value;
            let endpoint = document.getElementById('apiEndpoint').value;
            const body = document.getElementById('apiBody').value;
            
            if (!endpoint.startsWith('http')) {
                endpoint = window.location.origin + endpoint;
            }
            
            const options = {
                method: method,
                headers: { 'Content-Type': 'application/json' }
            };
            
            if ((method === 'POST' || method === 'PUT') && body) {
                options.body = body;
            }
            
            try {
                const response = await fetch(endpoint, options);
                const data = await response.json();
                document.getElementById('apiResponse').innerHTML = JSON.stringify(data, null, 2);
            } catch (err) {
                document.getElementById('apiResponse').innerHTML = '❌ Ошибка: ' + err.message;
            }
        }
        
        function showApiDocs() {
            const docs = document.getElementById('apiDocs');
            docs.style.display = docs.style.display === 'none' ? 'block' : 'none';
        }
        
        function switchTab(tab) {
            const callTab = document.getElementById('callTab');
            const apiTab = document.getElementById('apiTab');
            const tabCall = document.getElementById('tabCall');
            const tabApi = document.getElementById('tabApi');
            
            if (tab === 'call') {
                callTab.style.display = 'block';
                apiTab.style.display = 'none';
                tabCall.classList.add('active');
                tabApi.classList.remove('active');
            } else {
                callTab.style.display = 'none';
                apiTab.style.display = 'block';
                tabCall.classList.remove('active');
                tabApi.classList.add('active');
            }
        }
        
        async function updateRoomList() {
            try {
                const response = await fetch('/api/rooms');
                const data = await response.json();
                const roomList = document.getElementById('roomList');
                roomList.innerHTML = '';
                
                data.rooms.forEach(room => {
                    const type = room.roomInfo?.type || 'video';
                    const typeIcon = type === 'video' ? '📹' : '🎤';
                    const roomItem = document.createElement('div');
                    roomItem.className = 'room-item';
                    roomItem.onclick = () => joinRoomFromList(room.roomId);
                    roomItem.innerHTML = '<div class="room-name">' + room.roomId + '</div>' +
                        '<div class="room-type">' + typeIcon + ' ' + (type === 'video' ? 'Видео' : 'Аудио') + ' комната</div>' +
                        '<div class="participants">👥 ' + room.participants + ' участников</div>';
                    roomList.appendChild(roomItem);
                });
                
                updateStatus('sidebarStatus', '✅ Онлайн: ' + data.total + ' комнат', 'success');
            } catch (err) {
                updateStatus('sidebarStatus', '❌ Ошибка загрузки', 'error');
            }
        }
        
        function joinRoomFromList(roomId) {
            document.getElementById('roomInput').value = roomId;
            joinRoom();
        }
        
        async function testConnection() {
            updateStatus('callStatus', '🔄 Тестирование соединения...', 'info');
            try {
                const testPC = new RTCPeerConnection(configuration);
                let candidates = [];
                
                testPC.onicecandidate = (event) => {
                    if (event.candidate) {
                        candidates.push(event.candidate.candidate);
                    }
                };
                
                const constraints = currentCallType === 'video' 
                    ? { video: true, audio: true }
                    : { audio: true };
                
                const testStream = await navigator.mediaDevices.getUserMedia(constraints).catch(() => null);
                
                if (testStream) {
                    testStream.getTracks().forEach(track => track.stop());
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                if (candidates.length > 0) {
                    updateStatus('callStatus', '✅ Найдено ' + candidates.length + ' ICE кандидатов', 'success');
                } else {
                    updateStatus('callStatus', '⚠️ Нет ICE кандидатов', 'warning');
                }
                
                testPC.close();
            } catch (err) {
                updateStatus('callStatus', '❌ Ошибка: ' + err.message, 'error');
            }
        }
        
        async function joinRoom() {
            const roomId = document.getElementById('roomInput').value.trim();
            const callType = document.getElementById('callTypeSelect').value;
            
            if (!roomId) {
                alert('Введите название комнаты');
                return;
            }
            
            setCallType(callType);
            
            document.getElementById('joinBtn').disabled = true;
            document.getElementById('joinBtnText').classList.add('hidden');
            document.getElementById('joinBtnLoader').classList.remove('hidden');
            
            updateStatus('setupStatus', 'Запрос доступа к устройствам...', 'info');
            
            try {
                const constraints = callType === 'video' 
                    ? { 
                        video: {
                            width: { ideal: 640 },
                            height: { ideal: 480 },
                            frameRate: { ideal: 30 }
                        }, 
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true
                        }
                    }
                    : { 
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        } 
                    };
                
                localStream = await navigator.mediaDevices.getUserMedia(constraints);
                
                const localVideo = document.getElementById('localVideo');
                if (callType === 'video') {
                    localVideo.srcObject = localStream;
                } else {
                    localVideo.srcObject = null;
                }
                
                userName = document.getElementById('userName').value.trim() || 'Пользователь';
                
                if (mySocketId) {
                    await fetch('/api/users/' + mySocketId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            name: userName,
                            type: callType,
                            joinedAt: new Date().toISOString()
                        })
                    });
                }
                
                currentRoom = roomId;
                socket.emit('join-room', { roomId: roomId, userInfo: { name: userName, type: callType } });
                
            } catch (err) {
                updateStatus('setupStatus', 'Ошибка: ' + err.message, 'error');
                document.getElementById('joinBtn').disabled = false;
                document.getElementById('joinBtnText').classList.remove('hidden');
                document.getElementById('joinBtnLoader').classList.add('hidden');
            }
        }
        
        function createPeerConnection(peerId) {
            const pc = new RTCPeerConnection(configuration);
            
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    pc.addTrack(track, localStream);
                });
            }
            
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('ice-candidate', {
                        target: peerId,
                        candidate: event.candidate
                    });
                }
            };
            
            pc.oniceconnectionstatechange = () => {
                console.log('ICE состояние:', pc.iceConnectionState);
                if (pc.iceConnectionState === 'connected') {
                    updateStatus('callStatus', '✅ Соединение установлено', 'success');
                    
                    fetch('/api/calls/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            roomId: currentRoom,
                            callerId: mySocketId,
                            type: currentCallType
                        })
                    });
                }
            };
            
            pc.ontrack = (event) => {
                console.log('Получен удаленный трек');
                const remoteVideo = document.getElementById('remoteVideo');
                remoteVideo.srcObject = event.streams[0];
            };
            
            return pc;
        }
        
        socket.on('connect', () => {
            mySocketId = socket.id;
            updateStatus('setupStatus', '✅ Подключено к серверу', 'success');
            updateRoomList();
            setInterval(updateRoomList, 5000);
        });
        
        socket.on('join-success', (data) => {
            console.log('Подключились к комнате:', data);
            document.getElementById('setupSection').style.display = 'none';
            document.getElementById('videoSection').style.display = 'block';
            updateStatus('callStatus', '🟡 Ожидание собеседника...', 'info');
            document.getElementById('joinBtn').disabled = false;
            document.getElementById('joinBtnText').classList.remove('hidden');
            document.getElementById('joinBtnLoader').classList.add('hidden');
        });
        
        socket.on('peer-joined', async (peerId) => {
            console.log('Собеседник подключился:', peerId);
            updateStatus('callStatus', '🟡 Собеседник найден, соединение...', 'info');
            
            try {
                await new Promise(resolve => setTimeout(resolve, 500));
                peerConnection = createPeerConnection(peerId);
                const offer = await peerConnection.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: currentCallType === 'video'
                });
                await peerConnection.setLocalDescription(offer);
                socket.emit('offer', {
                    target: peerId,
                    offer: offer
                });
            } catch (err) {
                updateStatus('callStatus', 'Ошибка: ' + err.message, 'error');
            }
        });
        
        socket.on('offer', async ({ offer, sender }) => {
            console.log('Получен оффер');
            updateStatus('callStatus', '🟡 Получен запрос на соединение...', 'info');
            
            try {
                if (!peerConnection) {
                    peerConnection = createPeerConnection(sender);
                }
                await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('answer', {
                    target: sender,
                    answer: answer
                });
            } catch (err) {
                updateStatus('callStatus', 'Ошибка: ' + err.message, 'error');
            }
        });
        
        socket.on('answer', async ({ answer }) => {
            console.log('Получен ответ');
            try {
                if (peerConnection && !peerConnection.currentRemoteDescription) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                }
            } catch (err) {
                console.error('Ошибка:', err);
            }
        });
        
        socket.on('ice-candidate', async ({ candidate }) => {
            console.log('Получен ICE кандидат');
            if (peerConnection) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (err) {
                    console.error('Ошибка:', err);
                }
            }
        });
        
        socket.on('peer-disconnected', () => {
            console.log('Собеседник отключился');
            updateStatus('callStatus', '🔴 Собеседник отключился', 'error');
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            document.getElementById('remoteVideo').srcObject = null;
            updateStatus('callStatus', '🟡 Ожидание нового собеседника...', 'info');
        });
        
        socket.on('room-full', () => {
            alert('Комната переполнена! Максимум 2 участника.');
            hangUp();
        });
        
        function toggleAudio() {
            if (localStream) {
                const audioTrack = localStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = !audioTrack.enabled;
                    isAudioEnabled = audioTrack.enabled;
                    document.getElementById('audioBtn').innerHTML = isAudioEnabled ? 
                        '🔊 Выключить микрофон' : '🔇 Включить микрофон';
                }
            }
        }
        
        function toggleVideo() {
            if (localStream && currentCallType === 'video') {
                const videoTrack = localStream.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.enabled = !videoTrack.enabled;
                    isVideoEnabled = videoTrack.enabled;
                    document.getElementById('videoBtn').innerHTML = isVideoEnabled ? 
                        '📹 Выключить камеру' : '📹 Включить камеру';
                }
            }
        }
        
        function hangUp() {
            if (currentRoom && mySocketId) {
                fetch('/api/calls/active')
                    .then(res => res.json())
                    .then(data => {
                        const myCall = data.calls.find(call => 
                            call.roomId === currentRoom && 
                            call.participants && call.participants.includes(mySocketId)
                        );
                        if (myCall) {
                            fetch('/api/calls/end/' + myCall.callId, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ endedBy: mySocketId })
                            });
                        }
                    })
                    .catch(err => console.error('Ошибка при завершении звонка:', err));
            }
            
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }
            
            document.getElementById('localVideo').srcObject = null;
            document.getElementById('remoteVideo').srcObject = null;
            
            if (currentRoom) {
                socket.emit('leave-room', currentRoom);
                currentRoom = null;
            }
            
            document.getElementById('setupSection').style.display = 'block';
            document.getElementById('videoSection').style.display = 'none';
            document.getElementById('joinBtn').disabled = false;
            document.getElementById('joinBtnText').classList.remove('hidden');
            document.getElementById('joinBtnLoader').classList.add('hidden');
        }
    </script>
</body>
</html>
  `);
});

// Добавьте после других переменных окружения:
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Эндпоинт для получения App ID
app.get('/api/agora/app-id', (req, res) => {
    if (!AGORA_APP_ID) {
        return res.status(500).json({
            success: false,
            error: 'AGORA_APP_ID not configured'
        });
    }
    
    res.json({
        success: true,
        appId: AGORA_APP_ID
    });
});

// Эндпоинт для получения токена
app.post('/api/agora/token', (req, res) => {
    try {
        const { channelName, uid = 0 } = req.body;
        
        if (!channelName) {
            return res.status(400).json({ 
                success: false, 
                error: 'channelName is required' 
            });
        }

        if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
            return res.status(500).json({
                success: false,
                error: 'Agora credentials not configured'
            });
        }

        // Срок действия токена - 1 час
        const expirationTimeInSeconds = 3600;
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

        // Создаем токен
        const token = Agora.RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID,
            AGORA_APP_CERTIFICATE,
            channelName,
            uid,
            Agora.RtcRole.PUBLISHER,
            privilegeExpiredTs
        );

        console.log(`✅ Токен сгенерирован для канала ${channelName}, uid ${uid}`);
        
        res.json({
            success: true,
            token: token,
            appId: AGORA_APP_ID,
            channelName: channelName,
            uid: uid,
            expirationTime: privilegeExpiredTs
        });
    } catch (error) {
        console.error('❌ Ошибка генерации токена:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
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
    console.log(`📡 Socket.IO (чат и звонки) активен на /socket.io`);
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    console.log(`📁 Папка загрузок: ${uploadDir}`);
    console.log('='.repeat(60) + '\n');
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
