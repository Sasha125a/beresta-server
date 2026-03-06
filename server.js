// server.js - Объединенный сервер чата и звонков с FCM поддержкой и Supabase Storage
// ==================== ИМПОРТЫ ====================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');
const axios = require('axios'); // Для скачивания файлов из Supabase
const stream = require('stream');
const util = require('util');

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
let firebaseInitialized = false;

try {
    // Пробуем загрузить из переменной окружения (для Render.com)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        console.log('📦 Найден FIREBASE_SERVICE_ACCOUNT_JSON, пытаемся распарсить...');
        
        // Убираем экранирование если нужно
        let jsonString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (jsonString.startsWith('"') && jsonString.endsWith('"')) {
            jsonString = jsonString.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
        
        const serviceAccount = JSON.parse(jsonString);
        console.log(`✅ JSON распарсен, project_id: ${serviceAccount.project_id}`);
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin инициализирован из переменной окружения');
        console.log(`🔥 Проект: ${serviceAccount.project_id}`);
        console.log(`📧 Client email: ${serviceAccount.client_email}`);
    } 
    // Если нет, пробуем загрузить из файла (для локальной разработки)
    else {
        console.log('📦 FIREBASE_SERVICE_ACCOUNT_JSON не найден, ищем файл...');
        // Ищем любой файл, содержащий firebase-adminsdk
        const files = fs.readdirSync('./').filter(f => f.includes('firebase-adminsdk') && f.endsWith('.json'));
        if (files.length > 0) {
            const serviceAccount = require('./' + files[0]);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            firebaseInitialized = true;
            console.log(`✅ Firebase Admin инициализирован из файла: ${files[0]}`);
            console.log(`🔥 Проект: ${serviceAccount.project_id}`);
        } else {
            console.log('⚠️ Firebase credentials not found, FCM notifications disabled');
        }
    }
} catch (error) {
    console.error('❌ Ошибка инициализации Firebase Admin:', error.message);
    console.error('❌ Стек ошибки:', error.stack);
}

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: isRender ? ["https://beresta-server-5udn.onrender.com"] : "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// ВАЖНО: Добавляем middleware для парсинга JSON и URL-encoded данных
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Альтернативно можно использовать встроенный express.json()
// app.use(express.json({ limit: '50mb' }));
// app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseBucketName = process.env.SUPABASE_BUCKET_NAME || 'chat-files';

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ОШИБКА: SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть указаны в .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Создаем bucket если его нет
async function ensureBucketExists() {
    try {
        // Проверяем существует ли bucket
        const { data: buckets, error: listError } = await supabase
            .storage
            .listBuckets();

        if (listError) throw listError;

        const bucketExists = buckets.some(b => b.name === supabaseBucketName);
        
        if (!bucketExists) {
            console.log(`📦 Создание bucket "${supabaseBucketName}"...`);
            const { data, error } = await supabase
                .storage
                .createBucket(supabaseBucketName, {
                    public: true,
                    fileSizeLimit: 104857600, // 100MB
                    allowedMimeTypes: ['*/*']
                });

            if (error) throw error;
            console.log(`✅ Bucket "${supabaseBucketName}" создан`);
        } else {
            console.log(`✅ Bucket "${supabaseBucketName}" уже существует`);
        }
    } catch (error) {
        console.error('❌ Ошибка при создании bucket:', error);
    }
}

// Вызываем функцию создания bucket
ensureBucketExists();

// ==================== ЛОКАЛЬНОЕ ФАЙЛОВОЕ ХРАНИЛИЩЕ (ВРЕМЕННОЕ) ====================
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const tempDir = path.join(uploadDir, 'temp');

// Создаем папки, если их нет
[uploadDir, tempDir].forEach(dir => {
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

// ==================== ХРАНИЛИЩА ДАННЫХ ====================
const rooms = new Map();           // Комнаты и их участники
const roomsInfo = new Map();       // Информация о комнатах
const users = new Map();           // Информация о пользователях
const callHistory = new Map();     // История звонков
const activeCalls = new Map();     // Активные звонки
const emailToSocket = new Map();   // Маппинг email -> socket.id
const socketToEmail = new Map();   // Обратный маппинг

// Периодическая очистка старых звонков (раз в 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [roomId, callData] of activeCalls.entries()) {
        const startedAt = new Date(callData.startedAt || callData.startTime).getTime();
        if (now - startedAt > 60 * 60 * 1000) {
            activeCalls.delete(roomId);
            console.log(`🧹 Очищен старый звонок: ${roomId}`);
        }
    }
}, 5 * 60 * 1000);

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

// Функция для загрузки файла в Supabase Storage
async function uploadFileToSupabase(filePath, fileName, bucket = supabaseBucketName) {
    try {
        const fileContent = fs.readFileSync(filePath);
        const fileExt = path.extname(fileName);
        const uniqueFileName = `${Date.now()}_${uuidv4()}${fileExt}`;
        const filePathInBucket = `uploads/${uniqueFileName}`;

        const { data, error } = await supabase
            .storage
            .from(bucket)
            .upload(filePathInBucket, fileContent, {
                contentType: mime.lookup(fileName) || 'application/octet-stream',
                cacheControl: '3600',
                upsert: false
            });

        if (error) throw error;

        // Получаем публичный URL
        const { data: urlData } = supabase
            .storage
            .from(bucket)
            .getPublicUrl(filePathInBucket);

        console.log(`✅ Файл загружен в Supabase: ${urlData.publicUrl}`);
        
        return {
            success: true,
            path: filePathInBucket,
            url: urlData.publicUrl,
            fileName: uniqueFileName,
            originalName: fileName
        };
    } catch (error) {
        console.error('❌ Ошибка загрузки в Supabase:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Функция для удаления файла из Supabase Storage
async function deleteFileFromSupabase(filePath, bucket = supabaseBucketName) {
    try {
        const { error } = await supabase
            .storage
            .from(bucket)
            .remove([filePath]);

        if (error) throw error;

        console.log(`✅ Файл удален из Supabase: ${filePath}`);
        return { success: true };
    } catch (error) {
        console.error('❌ Ошибка удаления из Supabase:', error);
        return { success: false, error: error.message };
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

// Функция для отправки FCM уведомлений о звонках
async function sendFCMNotification(userEmail, title, body, data) {
    if (!firebaseInitialized) {
        console.log('❌ Firebase не инициализирован');
        return false;
    }

    try {
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
            data: {
                ...data,
                title: title,
                body: body,
                type: 'call',
                click_action: 'OPEN_CALL_ACTIVITY'
            },
            token: userData[0].fcm_token,
            android: {
                priority: 'high',
            },
        };

        const response = await admin.messaging().send(message);
        console.log(`✅ FCM уведомление о звонке отправлено для ${userEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Ошибка отправки FCM:', error);
        
        if (error.code === 'messaging/registration-token-not-registered') {
            await supabase
                .from('user_fcm_tokens')
                .delete()
                .eq('user_email', userEmail.toLowerCase());
            console.log(`🗑️ Удален устаревший FCM токен для ${userEmail}`);
        }
        
        return false;
    }
}

async function sendFCMNotificationForMessage(receiverEmail, senderName, senderEmail, message, messageId, isGroup = false, groupId = null, groupName = null) {
    if (!firebaseInitialized) {
        console.log('❌ Firebase не инициализирован');
        return false;
    }

    try {
        const { data: userData, error } = await supabase
            .from('user_fcm_tokens')
            .select('fcm_token')
            .eq('user_email', receiverEmail.toLowerCase())
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) throw error;

        if (!userData || userData.length === 0 || !userData[0].fcm_token) {
            console.log(`❌ Нет FCM токена для ${receiverEmail}`);
            return false;
        }

        const title = isGroup ? `💬 ${groupName || 'Групповой чат'}` : '💬 Новое сообщение';
        const body = `${senderName}: ${typeof message === 'string' ? message.substring(0, 50) : 'Файл'}${typeof message === 'string' && message.length > 50 ? '...' : ''}`;

        const messageData = {
            data: {
                type: 'message',
                senderName: senderName,
                senderEmail: senderEmail,
                message: typeof message === 'string' ? message : '[Файл]',
                messageId: messageId.toString(),
                isGroup: isGroup.toString(),
                groupId: groupId ? groupId.toString() : '',
                groupName: groupName || '',
                click_action: 'OPEN_CHAT_ACTIVITY',
                title: title,
                body: body
            },
            token: userData[0].fcm_token,
            android: {
                priority: 'high',
            },
        };

        const response = await admin.messaging().send(messageData);
        console.log(`✅ FCM уведомление о сообщении отправлено для ${receiverEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Ошибка отправки FCM для сообщения:', error);
        
        if (error.code === 'messaging/registration-token-not-registered') {
            await supabase
                .from('user_fcm_tokens')
                .delete()
                .eq('user_email', receiverEmail.toLowerCase());
            console.log(`🗑️ Удален устаревший FCM токен для ${receiverEmail}`);
        }
        
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

// ===== Health check =====
app.get('/health', async (req, res) => {
    try {
        const { error } = await supabase.from('regular_users').select('count', { count: 'exact', head: true });
        
        if (error) throw error;
        
        const { count } = await supabase
            .from('user_presence')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 30000).toISOString());

        const dirs = [uploadDir, tempDir];
        const dirStatus = {};
        dirs.forEach(dir => {
            dirStatus[path.basename(dir)] = fs.existsSync(dir);
        });

        // Проверка Supabase Storage
        const { data: buckets } = await supabase.storage.listBuckets();
        const storageAvailable = buckets && buckets.some(b => b.name === supabaseBucketName);

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
            supabaseStorage: {
                bucket: supabaseBucketName,
                available: storageAvailable
            },
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

// Загрузка файла с сохранением в Supabase
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'Файл не предоставлен' 
            });
        }

        const file = req.file;
        const { senderEmail, receiverEmail, isGroup, groupId, messageType = 'file' } = req.body;

        console.log('📤 Загрузка файла:', file.originalname);
        console.log('📤 Данные:', { senderEmail, receiverEmail, isGroup, groupId });

        // Загружаем файл в Supabase Storage
        const uploadResult = await uploadFileToSupabase(file.path, file.originalname);

        if (!uploadResult.success) {
            return res.status(500).json({
                success: false,
                error: 'Ошибка загрузки в Supabase Storage'
            });
        }

        // Определяем тип файла
        const fileType = getFileType(file.mimetype, file.originalname);

        // Создаем запись о файле в базе данных
        const fileRecord = {
            file_name: file.originalname,
            file_path: uploadResult.path,
            file_url: uploadResult.url,
            file_size: file.size,
            file_type: fileType,
            mime_type: file.mimetype,
            sender_email: senderEmail?.toLowerCase(),
            receiver_email: receiverEmail?.toLowerCase(),
            group_id: groupId,
            uploaded_at: new Date().toISOString()
        };

        const { data: fileData, error: fileError } = await supabase
            .from('files')
            .insert([fileRecord])
            .select();

        if (fileError) {
            console.error('❌ Ошибка сохранения записи о файле:', fileError);
            // Пытаемся удалить файл из Supabase
            await deleteFileFromSupabase(uploadResult.path);
            throw fileError;
        }

        console.log('✅ Файл сохранен в БД с ID:', fileData[0].id);

        // Если это сообщение, создаем запись в messages или group_messages
        if (senderEmail && (receiverEmail || groupId)) {
            if (groupId) {
                // Групповое сообщение с файлом
                const { data: messageData, error: messageError } = await supabase
                    .from('group_messages')
                    .insert([{
                        group_id: groupId,
                        sender_email: senderEmail.toLowerCase(),
                        message: req.body.message || '', // Используем переданное сообщение
                        file_id: fileData[0].id,
                        duration: 0
                    }])
                    .select();

                if (messageError) throw messageError;

                console.log('✅ Групповое сообщение создано с ID:', messageData[0].id);

                // Получаем информацию о группе и отправителе для уведомлений
                const { data: groupData } = await supabase
                    .from('groups')
                    .select('name')
                    .eq('id', groupId)
                    .single();

                const { data: members } = await supabase
                    .from('group_members')
                    .select('user_email')
                    .eq('group_id', groupId);

                const senderInfo = await getUserInfo(senderEmail);
                const senderName = senderInfo ? `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() : senderEmail;

                // Отправляем уведомления
                if (members) {
                    for (const member of members) {
                        if (member.user_email !== senderEmail.toLowerCase()) {
                            await sendFCMNotificationForMessage(
                                member.user_email,
                                senderName,
                                senderEmail,
                                req.body.message || `[${fileType}] ${file.originalname}`,
                                messageData[0].id,
                                true,
                                groupId,
                                groupData?.name
                            );
                        }
                    }
                }

                res.json({
                    success: true,
                    message: 'Файл загружен и сообщение отправлено',
                    file: {
                        id: fileData[0].id,
                        name: file.originalname,
                        url: uploadResult.url,
                        type: fileType,
                        size: file.size
                    },
                    messageId: messageData[0].id
                });
            } else if (receiverEmail) {
                // Личное сообщение с файлом
                const { data: messageData, error: messageError } = await supabase
                    .from('messages')
                    .insert([{
                        sender_email: senderEmail.toLowerCase(),
                        receiver_email: receiverEmail.toLowerCase(),
                        message: req.body.message || '', // Используем переданное сообщение
                        file_id: fileData[0].id,
                        duration: 0
                    }])
                    .select();

                if (messageError) throw messageError;

                console.log('✅ Личное сообщение создано с ID:', messageData[0].id);
                console.log('✅ Привязан файл ID:', fileData[0].id);

                // Добавляем в чаты автоматически
                await addToChatsAutomatically(senderEmail, receiverEmail);

                // Отправляем уведомление получателю
                const senderInfo = await getUserInfo(senderEmail);
                const senderName = senderInfo ? `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() : senderEmail;

                await sendFCMNotificationForMessage(
                    receiverEmail,
                    senderName,
                    senderEmail,
                    req.body.message || `[${fileType}] ${file.originalname}`,
                    messageData[0].id,
                    false
                );

                // Отправляем через Socket.IO
                const receiverSocketId = emailToSocket.get(receiverEmail.toLowerCase());
                if (receiverSocketId) {
                    io.to(receiverSocketId).emit('new_message', {
                        id: messageData[0].id,
                        senderEmail: senderEmail,
                        message: req.body.message || '',
                        file: {
                            id: fileData[0].id,
                            name: file.originalname,
                            url: uploadResult.url,
                            type: fileType,
                            size: file.size
                        },
                        timestamp: new Date().toISOString()
                    });
                }

                res.json({
                    success: true,
                    message: 'Файл загружен и сообщение отправлено',
                    file: {
                        id: fileData[0].id,
                        name: file.originalname,
                        url: uploadResult.url,
                        type: fileType,
                        size: file.size
                    },
                    messageId: messageData[0].id
                });
            } else {
                res.json({
                    success: true,
                    file: {
                        id: fileData[0].id,
                        name: file.originalname,
                        url: uploadResult.url,
                        type: fileType,
                        size: file.size
                    }
                });
            }
        } else {
            res.json({
                success: true,
                file: {
                    id: fileData[0].id,
                    name: file.originalname,
                    url: uploadResult.url,
                    type: fileType,
                    size: file.size
                }
            });
        }

        // Удаляем временный файл после загрузки в Supabase
        fs.unlink(file.path, (err) => {
            if (err) console.error('❌ Ошибка удаления временного файла:', err);
            else console.log('🗑️ Временный файл удален:', file.path);
        });

    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка загрузки файла',
            details: error.message 
        });
    }
});

// ===== Получение информации о файле =====
app.get('/files/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        const { data, error } = await supabase
            .from('files')
            .select('*')
            .eq('id', fileId)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: 'Файл не найден'
            });
        }

        res.json({
            success: true,
            file: data
        });
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ===== Получение файлов сообщения =====
app.get('/messages/:messageId/files', async (req, res) => {
    try {
        const { messageId } = req.params;

        // Проверяем в обычных сообщениях
        const { data: messageData, error: messageError } = await supabase
            .from('messages')
            .select('file_id')
            .eq('id', messageId)
            .single();

        if (messageData && messageData.file_id) {
            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .select('*')
                .eq('id', messageData.file_id)
                .single();

            if (!fileError && fileData) {
                return res.json({
                    success: true,
                    files: [fileData]
                });
            }
        }

        // Проверяем в групповых сообщениях
        const { data: groupMessageData, error: groupMessageError } = await supabase
            .from('group_messages')
            .select('file_id')
            .eq('id', messageId)
            .single();

        if (groupMessageData && groupMessageData.file_id) {
            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .select('*')
                .eq('id', groupMessageData.file_id)
                .single();

            if (!fileError && fileData) {
                return res.json({
                    success: true,
                    files: [fileData]
                });
            }
        }

        res.json({
            success: true,
            files: []
        });
    } catch (error) {
        console.error('❌ Ошибка получения файлов сообщения:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ===== Получение файлов пользователя =====
app.get('/users/:email/files', async (req, res) => {
    try {
        const email = req.params.email.toLowerCase();

        const { data, error } = await supabase
            .from('files')
            .select('*')
            .eq('sender_email', email)
            .order('uploaded_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            files: data || []
        });
    } catch (error) {
        console.error('❌ Ошибка получения файлов пользователя:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ===== Удаление файла =====
app.delete('/files/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        // Получаем информацию о файле
        const { data: fileData, error: fileError } = await supabase
            .from('files')
            .select('*')
            .eq('id', fileId)
            .single();

        if (fileError || !fileData) {
            return res.status(404).json({
                success: false,
                error: 'Файл не найден'
            });
        }

        // Удаляем из Supabase Storage
        const deleteResult = await deleteFileFromSupabase(fileData.file_path);

        if (!deleteResult.success) {
            console.warn('⚠️ Не удалось удалить файл из хранилища:', deleteResult.error);
        }

        // Удаляем запись из базы данных
        const { error: deleteError } = await supabase
            .from('files')
            .delete()
            .eq('id', fileId);

        if (deleteError) throw deleteError;

        // Удаляем ссылки на файл в сообщениях
        await supabase
            .from('messages')
            .update({ file_id: null })
            .eq('file_id', fileId);

        await supabase
            .from('group_messages')
            .update({ file_id: null })
            .eq('file_id', fileId);

        res.json({
            success: true,
            message: 'Файл удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления файла:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

/**
 * Получение групп пользователя
 */
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
                member_count: count || 0
            };
        }));

        res.json({
            success: true,
            groups
        });
    } catch (error) {
        console.error('❌ Ошибка получения групп:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
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
        
        if (callerEmail.toLowerCase() === receiverEmail.toLowerCase()) {
            return res.status(400).json({
                success: false,
                error: 'Нельзя позвонить самому себе'
            });
        }
        
        const roomId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        
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
                userEmail: receiverEmail,
                accept_action: 'ACCEPT_CALL',
                reject_action: 'REJECT_CALL'
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
 * Проверить FCM токен пользователя
 */
app.get('/api/fcm/check/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        console.log(`🔍 Проверка FCM токена для: ${normalizedEmail}`);
        
        const { data, error } = await supabase
            .from('user_fcm_tokens')
            .select('*')
            .eq('user_email', normalizedEmail)
            .order('created_at', { ascending: false });
            
        if (error) {
            console.error('❌ Ошибка запроса к Supabase:', error);
            throw error;
        }
        
        const userInfo = await getUserInfo(normalizedEmail);
        
        const response = {
            success: true,
            email: normalizedEmail,
            exists: userInfo !== null,
            hasToken: data && data.length > 0,
            tokenCount: data ? data.length : 0,
            tokens: data ? data.map(t => ({
                token_preview: t.fcm_token.substring(0, 20) + '...',
                created_at: t.created_at,
                updated_at: t.updated_at
            })) : [],
            message: data && data.length > 0 
                ? `✅ Токен найден: ${data[0].fcm_token.substring(0, 20)}...` 
                : '❌ Токен не найден'
        };
        
        console.log(response.message);
        
        res.json(response);
    } catch (error) {
        console.error('❌ Ошибка проверки FCM токена:', error);
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

/**
 * Регистрация обычного пользователя
 */
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

/**
 * Получение информации о пользователе
 */
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

/**
 * Получение всех пользователей
 */
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

/**
 * Получение чатов пользователя
 */
app.get('/chats/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        console.log('🔄 Получение чатов для:', userEmail);

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

        const chats = await Promise.all(friends.map(async (friend) => {
            const friendEmail = friend.friend_email;
            const friendInfo = await getUserInfo(friendEmail);

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

/**
 * Получение сообщений между пользователями
 */
app.get('/messages/:userEmail/:friendEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        const friendEmail = req.params.friendEmail.toLowerCase();

        // Получаем сообщения с информацией о файлах
        const { data, error } = await supabase
            .from('messages')
            .select(`
                *,
                files:file_id (*)
            `)
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

/**
 * Отправка текстового сообщения
 */
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

        await addToChatsAutomatically(senderEmail, receiverEmail);

        // Отправляем FCM уведомление получателю
        const senderName = `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() || senderEmail;
        await sendFCMNotificationForMessage(
            receiverEmail,
            senderName,
            senderEmail,
            message || '',
            data[0].id,
            false
        );

        // Отправляем через Socket.IO если получатель онлайн
        const receiverSocketId = emailToSocket.get(receiverEmail.toLowerCase());
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new_message', {
                id: data[0].id,
                senderEmail: senderEmail,
                message: message,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            messageId: data[0].id
        });
    } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Отправка группового сообщения
 */
app.post('/send-group-message', async (req, res) => {
    try {
        const { groupId, senderEmail, message, duration } = req.body;

        if (!groupId || !senderEmail) {
            return res.status(400).json({
                success: false,
                error: 'Группа и отправитель обязательны'
            });
        }

        const senderInfo = await getUserInfo(senderEmail);
        if (!senderInfo) {
            return res.status(404).json({
                success: false,
                error: 'Отправитель не найден'
            });
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

        // Получаем название группы
        const { data: groupData } = await supabase
            .from('groups')
            .select('name')
            .eq('id', groupId)
            .single();

        // Получаем всех участников группы
        const { data: members, error: membersError } = await supabase
            .from('group_members')
            .select('user_email')
            .eq('group_id', groupId);

        if (!membersError && members) {
            const senderName = `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() || senderEmail;
            const groupName = groupData?.name || 'Группа';
            
            // Отправляем уведомления всем участникам кроме отправителя
            for (const member of members) {
                if (member.user_email !== senderEmail.toLowerCase()) {
                    await sendFCMNotificationForMessage(
                        member.user_email,
                        senderName,
                        senderEmail,
                        message || '',
                        data[0].id,
                        true,
                        groupId,
                        groupName
                    );
                }
            }
        }

        res.json({
            success: true,
            messageId: data[0].id
        });
    } catch (error) {
        console.error('❌ Ошибка отправки группового сообщения:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Добавление друга
 */
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

        await supabase
            .from('friends')
            .upsert({
                user_email: normalizedUserEmail,
                friend_email: normalizedFriendEmail
            }, {
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true
            });

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

app.get('/api/debug/firebase', (req, res) => {
    res.json({
        success: true,
        firebaseInitialized: firebaseInitialized
    });
});

app.get('/api/debug/storage', async (req, res) => {
    try {
        const { data: buckets } = await supabase.storage.listBuckets();
        const bucketInfo = buckets?.find(b => b.name === supabaseBucketName);

        res.json({
            success: true,
            bucketName: supabaseBucketName,
            bucketExists: !!bucketInfo,
            bucketInfo: bucketInfo,
            allBuckets: buckets?.map(b => b.name)
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// ===== СТАТИЧЕСКИЕ ФАЙЛЫ (для обратной совместимости) =====
app.use('/uploads', express.static(uploadDir));

// ===== ВЕБ-ИНТЕРФЕЙС =====
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Beresta Server</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
            h1 { color: #333; }
            .status { padding: 20px; background: #f0f0f0; border-radius: 5px; }
            .online { color: green; }
            .storage { color: blue; }
            .feature { margin-left: 20px; }
        </style>
    </head>
    <body>
        <h1>🚀 Beresta Server</h1>
        <div class="status">
            <p><strong>Status:</strong> <span class="online">🟢 Online</span></p>
            <p><strong>Server ID:</strong> ${SERVER_ID}</p>
            <p><strong>Firebase:</strong> ${firebaseInitialized ? '✅ Активен' : '❌ Не настроен'}</p>
            <p><strong>Supabase Storage:</strong> <span class="storage">✅ Активен (bucket: ${supabaseBucketName})</span></p>
            <p><strong>Active Rooms:</strong> ${rooms.size}</p>
            <p><strong>Active Calls:</strong> ${activeCalls.size}</p>
            <p><strong>Total Users:</strong> ${users.size}</p>
        </div>
        <div class="features">
            <h2>📋 Доступные эндпоинты:</h2>
            <ul>
                <li><strong>POST /upload</strong> - Загрузка файла (multipart/form-data)</li>
                <li><strong>GET /files/:fileId</strong> - Информация о файле</li>
                <li><strong>GET /messages/:messageId/files</strong> - Файлы сообщения</li>
                <li><strong>GET /users/:email/files</strong> - Файлы пользователя</li>
                <li><strong>DELETE /files/:fileId</strong> - Удаление файла</li>
                <li><strong>POST /send-message</strong> - Отправка сообщения</li>
                <li><strong>POST /send-group-message</strong> - Отправка группового сообщения</li>
                <li><strong>GET /chats/:userEmail</strong> - Чаты пользователя</li>
                <li><strong>GET /messages/:userEmail/:friendEmail</strong> - История переписки</li>
            </ul>
        </div>
    </body>
    </html>
    `);
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
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    console.log(`📦 Supabase Storage: ${supabaseBucketName}`);
    console.log(`📁 Локальная папка загрузок (временная): ${tempDir}`);
    console.log(`📧 Маппинг email->socketId активен`);
    console.log(`🔥 Firebase: ${firebaseInitialized ? 'активен' : 'не настроен'}`);
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
    
    // Очистка временной папки при остановке
    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            fs.unlinkSync(path.join(tempDir, file));
        }
        console.log('✅ Временные файлы удалены');
    } catch (error) {
        console.error('❌ Ошибка очистки временных файлов:', error);
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
