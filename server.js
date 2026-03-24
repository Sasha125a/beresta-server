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
const axios = require('axios');
const stream = require('stream');
const util = require('util');
const mime = require('mime-types');

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

// Хранилище для таймаутов звонков
const callTimeouts = new Map(); // roomId -> { timeoutId, createdAt }

// ==================== FIREBASE ADMIN ====================
let firebaseInitialized = false;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        console.log('📦 Найден FIREBASE_SERVICE_ACCOUNT_JSON, пытаемся распарсить...');
        
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
    else {
        console.log('📦 FIREBASE_SERVICE_ACCOUNT_JSON не найден, ищем файл...');
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

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ==================== ОТСЛЕЖИВАНИЕ АКТИВНОСТИ ПОЛЬЗОВАТЕЛЕЙ ====================
const userLastActivity = new Map(); // email -> timestamp последней активности
const ACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 минут без активности = оффлайн
const ACTIVITY_CHECK_INTERVAL = 60000; // Проверка каждую минуту

// Функция обновления активности пользователя
async function updateUserActivity(email) {
    if (!email) return;
    
    const normalizedEmail = email.toLowerCase();
    const now = Date.now();
    const lastActivity = userLastActivity.get(normalizedEmail) || 0;
    
    // Обновляем время активности
    userLastActivity.set(normalizedEmail, now);
    
    // Если пользователь был неактивен больше ACTIVITY_TIMEOUT, меняем статус на онлайн
    if (now - lastActivity > ACTIVITY_TIMEOUT) {
        console.log(`👤 Пользователь ${normalizedEmail} стал онлайн (активность)`);
        
        // Обновляем в базе
        await updateUserPresence(normalizedEmail, null, 'online');
        
        // Уведомляем всех о смене статуса
        io.emit('user_status_changed', {
            email: normalizedEmail,
            status: 'online',
            timestamp: new Date().toISOString(),
            source: 'activity'
        });
    }
    
    return true;
}

// Функция проверки неактивных пользователей
async function checkInactiveUsers() {
    const now = Date.now();
    const offlineThreshold = now - ACTIVITY_TIMEOUT;
    
    for (const [email, lastActivity] of userLastActivity.entries()) {
        if (lastActivity < offlineThreshold) {
            console.log(`👤 Пользователь ${email} стал оффлайн (неактивен ${Math.round((now - lastActivity)/1000)}с)`);
            
            // Удаляем из активных
            userLastActivity.delete(email);
            
            // Обновляем в базе
            await updateUserPresence(email, null, 'offline');
            
            // Уведомляем всех о смене статуса
            io.emit('user_status_changed', {
                email: email,
                status: 'offline',
                timestamp: new Date().toISOString(),
                source: 'inactivity'
            });
        }
    }
}

// Запускаем периодическую проверку неактивных пользователей
setInterval(checkInactiveUsers, ACTIVITY_CHECK_INTERVAL);

// ==================== MIDDLEWARE ДЛЯ ОТСЛЕЖИВАНИЯ АКТИВНОСТИ ====================
app.use(async (req, res, next) => {
    if (req.path.startsWith('/uploads') || req.path === '/health' || req.path === '/' || req.path.startsWith('/api/debug')) {
        return next();
    }
    
    let email = null;
    
    if (req.query.email) {
        email = req.query.email;
    }
    else if (req.query.userEmail) {
        email = req.query.userEmail;
    }
    else if (req.body) {
        if (req.body.email) email = req.body.email;
        else if (req.body.userEmail) email = req.body.userEmail;
        else if (req.body.senderEmail) email = req.body.senderEmail;
        else if (req.body.callerEmail) email = req.body.callerEmail;
        else if (req.body.receiverEmail) email = req.body.receiverEmail;
    }
    else if (req.params) {
        if (req.params.email) email = req.params.email;
        else if (req.params.userEmail) email = req.params.userEmail;
    }
    else if (req.headers['x-user-email']) {
        email = req.headers['x-user-email'];
    }
    
    if (email) {
        updateUserActivity(email).catch(err => 
            console.error('❌ Ошибка обновления активности:', err)
        );
    }
    
    next();
});

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseBucketName = process.env.SUPABASE_BUCKET_NAME || 'chat-files';

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ОШИБКА: SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть указаны в .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Проверяем наличие bucket
async function ensureBucketExists() {
    try {
        console.log('🔍 Проверка наличия bucket...');
        
        const { data: buckets, error: listError } = await supabase
            .storage
            .listBuckets();

        if (listError) {
            console.error('❌ Ошибка при получении списка bucket-ов:', listError);
            return false;
        }

        console.log('📦 Найденные bucket-ы:', buckets.map(b => b.name));

        const bucketExists = buckets.some(b => b.name === supabaseBucketName);
        
        if (bucketExists) {
            console.log(`✅ Bucket "${supabaseBucketName}" уже существует`);
            
            const bucket = buckets.find(b => b.name === supabaseBucketName);
            console.log('📊 Текущие настройки bucket:', {
                public: bucket.public,
                fileSizeLimit: bucket.file_size_limit ? `${bucket.file_size_limit / (1024 * 1024)} MB` : 'не ограничен',
                allowedMimeTypes: bucket.allowed_mime_types
            });
            
            return true;
        } else {
            console.error(`❌ Bucket "${supabaseBucketName}" не найден!`);
            console.log('⚠️ Пожалуйста, создайте bucket вручную в панели Supabase');
            return false;
        }
    } catch (error) {
        console.error('❌ Ошибка при проверке bucket:', error);
        return false;
    }
}

// ==================== ЛОКАЛЬНОЕ ФАЙЛОВОЕ ХРАНИЛИЩЕ (ВРЕМЕННОЕ) ====================
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const tempDir = path.join(uploadDir, 'temp');

[uploadDir, tempDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Создана папка: ${dir}`);
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

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 МБ

const upload = multer({
    storage: multerStorage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        fieldSize: MAX_FILE_SIZE
    },
    fileFilter: (req, file, cb) => {
        if (file.size > MAX_FILE_SIZE) {
            return cb(new Error(`Файл слишком большой. Максимальный размер: 50 МБ`));
        }
        cb(null, true);
    }
});

// ==================== ХРАНИЛИЩА ДАННЫХ ====================
const rooms = new Map();
const roomsInfo = new Map();
const users = new Map();
const callHistory = new Map();
const activeCalls = new Map();
const emailToSocket = new Map();
const socketToEmail = new Map();

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
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.3gp'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'].includes(ext)) return 'document';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive';
    
    return 'file';
}

async function uploadFileToSupabase(filePath, fileName, bucket = supabaseBucketName) {
    try {
        console.log(`📤 Загрузка файла в Supabase: ${fileName}`);
        
        const fileContent = fs.readFileSync(filePath);
        const fileExt = path.extname(fileName);
        const uniqueFileName = `${Date.now()}_${uuidv4()}${fileExt}`;
        const filePathInBucket = `uploads/${uniqueFileName}`;

        console.log(`📁 Путь в bucket: ${filePathInBucket}`);
        console.log(`📊 Размер файла: ${fileContent.length} байт`);

        const { data: buckets } = await supabase.storage.listBuckets();
        const bucketExists = buckets.some(b => b.name === bucket);
        
        if (!bucketExists) {
            console.log(`⚠️ Bucket "${bucket}" не найден, создаем...`);
            await supabase.storage.createBucket(bucket, {
                public: true,
                fileSizeLimit: 104857600
            });
        }

        const { data, error } = await supabase
            .storage
            .from(bucket)
            .upload(filePathInBucket, fileContent, {
                contentType: mime.lookup(fileName) || 'application/octet-stream',
                cacheControl: '3600',
                upsert: false
            });

        if (error) {
            console.error('❌ Ошибка загрузки в Supabase:', error);
            throw error;
        }

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
            originalName: fileName,
            size: fileContent.length
        };
    } catch (error) {
        console.error('❌ Ошибка загрузки в Supabase:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

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

async function sendMissedCallNotification(receiverEmail, callerEmail, callType, roomId) {
    try {
        const callerInfo = await getUserInfo(callerEmail);
        const callerName = callerInfo ? 
            `${callerInfo.first_name || ''} ${callerInfo.last_name || ''}`.trim() || callerEmail : 
            callerEmail;
        
        console.log(`📱 Отправка уведомления о пропущенном звонке для ${receiverEmail} от ${callerName}`);
        
        try {
            await supabase
                .from('missed_calls')
                .insert([{
                    room_id: roomId,
                    caller_email: callerEmail.toLowerCase(),
                    caller_name: callerName,
                    receiver_email: receiverEmail.toLowerCase(),
                    call_type: callType || 'audio',
                    started_at: new Date().toISOString(),
                    is_read: false
                }]);
            console.log(`💾 Пропущенный звонок сохранен в БД`);
        } catch (dbError) {
            console.error('❌ Ошибка сохранения в БД:', dbError);
        }
        
        const fcmSent = await sendFCMNotification(
            receiverEmail,
            '📞 Пропущенный звонок',
            `${callerName} (${callType === 'video' ? 'видео' : 'аудио'})`,
            {
                type: 'missed_call',
                roomId: roomId,
                caller: callerEmail,
                callerName: callerName,
                callType: callType || 'audio',
                userEmail: receiverEmail,
                timestamp: new Date().toISOString()
            }
        );
        
        const receiverSocketId = emailToSocket.get(receiverEmail.toLowerCase());
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('missed-call', {
                type: 'missed-call',
                roomId: roomId,
                caller: callerEmail,
                callerName: callerName,
                callType: callType || 'audio',
                timestamp: new Date().toISOString()
            });
        }
        
        return fcmSent;
    } catch (error) {
        console.error('❌ Ошибка отправки уведомления о пропущенном звонке:', error);
        return false;
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
        const now = Date.now();
        const offlineThreshold = new Date(now - ACTIVITY_TIMEOUT).toISOString();
        
        const { error } = await supabase
            .from('user_presence')
            .delete()
            .lt('last_seen', offlineThreshold);

        if (error) throw error;
        
        await checkInactiveUsers();
        
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
            token: userData[0].fcm_token,
            
            data: {
                type: 'message',
                senderName: senderName,
                senderEmail: senderEmail,
                message: typeof message === 'string' ? message : '[Файл]',
                messageId: messageId.toString(),
                isGroup: isGroup.toString(),
                groupId: groupId ? groupId.toString() : '',
                groupName: groupName || '',
                title: title,
                body: body,
                click_action: 'OPEN_CHAT_ACTIVITY',
                timestamp: new Date().toISOString()
            },
            
            notification: {
                title: title,
                body: body,
                image: undefined
            },
            
            android: {
                priority: 'high',
                notification: {
                    channelId: 'messages',
                    priority: 'high',
                    visibility: 'public',
                    clickAction: 'OPEN_CHAT_ACTIVITY',
                    sound: 'default',
                    defaultSound: true,
                    defaultVibrate: true,
                    vibrate: [1000, 1000, 1000],
                    color: '#2196F3',
                    icon: 'ic_notification',
                    tag: messageId.toString(),
                    sticky: false,
                    notificationCount: 1,
                    ticker: title + ': ' + body,
                    localOnly: false,
                    notificationPriority: 1,
                    visibility: 1
                }
            },
            
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title: title,
                            body: body
                        },
                        sound: 'default',
                        badge: 1,
                        category: 'MESSAGE_CATEGORY',
                        'mutable-content': 1
                    }
                }
            }
        };

        if (userData[0].fcm_token && (userData[0].fcm_token.startsWith('c') || userData[0].fcm_token.startsWith('e'))) {
            const intent = {
                action: 'OPEN_CHAT_ACTIVITY',
                type: 'text/plain',
                flags: ['FLAG_ACTIVITY_NEW_TASK', 'FLAG_ACTIVITY_CLEAR_TOP'],
                categories: ['android.intent.category.LAUNCHER'],
                package: 'ru.beresta.messenger',
                extras: {
                    'senderName': senderName,
                    'senderEmail': senderEmail,
                    'messageId': messageId.toString(),
                    'isGroup': isGroup,
                    'groupId': groupId ? groupId.toString() : '',
                    'groupName': groupName || ''
                }
            };
            
            messageData.android.notification.clickIntent = intent;
            messageData.android.notification.fullScreenIntent = intent;
        }

        console.log(`📦 Отправка FCM сообщения для ${receiverEmail}`);

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

// ===== ФУНКЦИИ ДЛЯ АВТОМАТИЧЕСКОЙ ОЧИСТКИ ФАЙЛОВ =====

async function cleanupOldFiles() {
    try {
        console.log('🧹 Запуск очистки старых файлов...');
        
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        const cutoffDate = tenDaysAgo.toISOString();
        
        console.log(`📅 Удаляем файлы старше: ${cutoffDate}`);

        const { data: oldFiles, error: selectError } = await supabase
            .from('files')
            .select('*')
            .lt('uploaded_at', cutoffDate);

        if (selectError) {
            console.error('❌ Ошибка при поиске старых файлов:', selectError);
            return;
        }

        if (!oldFiles || oldFiles.length === 0) {
            console.log('✅ Старых файлов не найдено');
            return;
        }

        console.log(`📦 Найдено ${oldFiles.length} старых файлов для удаления`);

        let deletedCount = 0;
        let errorCount = 0;

        for (const file of oldFiles) {
            try {
                if (file.file_path) {
                    const { error: storageError } = await supabase
                        .storage
                        .from(supabaseBucketName)
                        .remove([file.file_path]);

                    if (storageError) {
                        console.error(`❌ Ошибка удаления из storage: ${file.file_path}`, storageError);
                        errorCount++;
                        continue;
                    }
                }

                const { error: dbError } = await supabase
                    .from('files')
                    .delete()
                    .eq('id', file.id);

                if (dbError) {
                    console.error(`❌ Ошибка удаления из БД: файл ID ${file.id}`, dbError);
                    errorCount++;
                    continue;
                }

                await supabase
                    .from('messages')
                    .update({ file_id: null })
                    .eq('file_id', file.id);

                await supabase
                    .from('group_messages')
                    .update({ file_id: null })
                    .eq('file_id', file.id);

                deletedCount++;
                console.log(`✅ Удален файл ID ${file.id}: ${file.file_name} (загружен ${file.uploaded_at})`);

            } catch (error) {
                console.error(`❌ Ошибка при удалении файла ID ${file.id}:`, error);
                errorCount++;
            }
        }

        console.log(`🧹 Очистка завершена: удалено ${deletedCount} файлов, ошибок: ${errorCount}`);

    } catch (error) {
        console.error('❌ Ошибка в cleanupOldFiles:', error);
    }
}

function startFileCleanupScheduler() {
    console.log('⏰ Запуск планировщика очистки файлов (каждые 24 часа)');
    
    setTimeout(() => {
        cleanupOldFiles();
    }, 60000);
    
    setInterval(() => {
        cleanupOldFiles();
    }, 24 * 60 * 60 * 1000);
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
                
                await updateUserActivity(email);
                
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
        try {
            const roomId = data.roomId;
            const userInfo = data.userInfo || {};
            
            console.log('📢 ' + socket.id + ' подключается к комнате звонка: ' + roomId);
            
            if (userInfo.email) {
                const email = userInfo.email.toLowerCase();
                
                const oldSocketId = emailToSocket.get(email);
                if (oldSocketId && oldSocketId !== socket.id) {
                    console.log(`⚠️ Обнаружен дубликат для ${email}, старый socket: ${oldSocketId}`);
                }
                
                emailToSocket.set(email, socket.id);
                socketToEmail.set(socket.id, email);
                socket.userEmail = email;
                
                console.log(`📧 Маппинг: ${email} -> ${socket.id}`);
            }
            
            if (!rooms.has(roomId)) {
                rooms.set(roomId, new Set());
            }
            
            const room = rooms.get(roomId);
            
            if (room.has(socket.id)) {
                console.log(`⚠️ Сокет ${socket.id} уже в комнате ${roomId}`);
                return;
            }
            
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
            
            socket.emit('join-success', { 
                roomId: roomId, 
                participants: Array.from(room),
                isFirstParticipant: room.size === 1
            });
            
            if (room.size > 1) {
                socket.to(roomId).emit('peer-joined', {
                    peerId: socket.id,
                    peerEmail: socket.userEmail,
                    peerInfo: userInfo
                });
                
                const otherParticipants = Array.from(room).filter(id => id !== socket.id);
                socket.emit('peer-list', {
                    participants: otherParticipants.map(id => ({
                        socketId: id,
                        email: socketToEmail.get(id) || 'unknown'
                    }))
                });
                
                setTimeout(() => {
                    if (rooms.has(roomId) && rooms.get(roomId).has(socket.id)) {
                        socket.emit('peer-ready', {
                            message: 'Собеседник готов к соединению',
                            participants: otherParticipants
                        });
                    }
                }, 1000);
            }
            
            io.emit('rooms-updated');
            
        } catch (error) {
            console.error('❌ Ошибка в join-room:', error);
            socket.emit('join-error', { message: error.message });
        }
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
    });

    socket.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
});

function handleDisconnect(socket, specificRoom = null) {
    let roomId = specificRoom;
    let email = socket.userEmail || socketToEmail.get(socket.id);
    
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
        
        if (room.size > 0) {
            socket.to(roomId).emit('peer-disconnected', {
                peerId: socket.id,
                peerEmail: email,
                reason: 'disconnected'
            });
        }
        
        if (room.size === 0) {
            rooms.delete(roomId);
            roomsInfo.delete(roomId);
            
            if (activeCalls.has(roomId)) {
                const callData = activeCalls.get(roomId);
                const endedCall = {
                    ...callData,
                    endedBy: 'system',
                    endTime: new Date().toISOString(),
                    status: 'ended',
                    duration: calculateDuration(callData.startedAt)
                };
                const historyId = 'hist_' + Date.now();
                callHistory.set(historyId, endedCall);
                activeCalls.delete(roomId);
                console.log(`📴 Звонок ${roomId} завершен (комната пуста)`);
            }
        } else {
            console.log('👋 ' + socket.id + ' покинул комнату ' + roomId + ', осталось: ' + room.size);
        }
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

        const { data: buckets } = await supabase.storage.listBuckets();
        const storageAvailable = buckets && buckets.some(b => b.name === supabaseBucketName);
        
        const onlineUsers = Array.from(userLastActivity.entries())
            .filter(([_, lastActivity]) => Date.now() - lastActivity < ACTIVITY_TIMEOUT)
            .length;

        res.json({
            success: true,
            status: 'Server is running optimally',
            serverId: SERVER_ID,
            stats: {
                activeRooms: rooms.size,
                totalUsers: users.size,
                activeCalls: activeCalls.size,
                onlineUsers: onlineUsers,
                databaseOnlineUsers: count || 0,
                totalCallsToday: getTodayCallsCount()
            },
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            directories: dirStatus,
            supabaseStorage: {
                bucket: supabaseBucketName,
                available: storageAvailable
            },
            activityTracking: {
                timeout: ACTIVITY_TIMEOUT / 1000 / 60 + ' минут',
                trackedUsers: userLastActivity.size
            },
            callTimeouts: {
                active: callTimeouts.size,
                timeouts: Array.from(callTimeouts.entries()).map(([roomId, data]) => ({
                    roomId,
                    createdAt: data.createdAt,
                    age: Date.now() - new Date(data.createdAt).getTime()
                }))
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

// ===== Загрузка файла =====
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

        if (senderEmail) {
            await updateUserActivity(senderEmail);
        }

        const uploadResult = await uploadFileToSupabase(file.path, file.originalname);

        if (!uploadResult.success) {
            return res.status(500).json({
                success: false,
                error: 'Ошибка загрузки в Supabase Storage'
            });
        }

        const fileType = getFileType(file.mimetype, file.originalname);

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
            await deleteFileFromSupabase(uploadResult.path);
            throw fileError;
        }

        console.log('✅ Файл сохранен в БД с ID:', fileData[0].id);

        if (senderEmail && (receiverEmail || groupId)) {
            if (groupId) {
                const { data: messageData, error: messageError } = await supabase
                    .from('group_messages')
                    .insert([{
                        group_id: groupId,
                        sender_email: senderEmail.toLowerCase(),
                        message: req.body.message || '',
                        file_id: fileData[0].id,
                        duration: 0
                    }])
                    .select();

                if (messageError) throw messageError;

                console.log('✅ Групповое сообщение создано с ID:', messageData[0].id);

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
                const { data: messageData, error: messageError } = await supabase
                    .from('messages')
                    .insert([{
                        sender_email: senderEmail.toLowerCase(),
                        receiver_email: receiverEmail.toLowerCase(),
                        message: req.body.message || '',
                        file_id: fileData[0].id,
                        duration: 0
                    }])
                    .select();

                if (messageError) throw messageError;

                console.log('✅ Личное сообщение создано с ID:', messageData[0].id);
                console.log('✅ Привязан файл ID:', fileData[0].id);

                await addToChatsAutomatically(senderEmail, receiverEmail);

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

// ===== Получение файлов сообщения =====
app.get('/messages/:messageId/files', async (req, res) => {
    try {
        const { messageId } = req.params;

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

        await updateUserActivity(email);

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

// ===== Обновление профиля пользователя =====
app.post('/update-profile', upload.single('avatar'), async (req, res) => {
    try {
        const { email, firstName, lastName, removeAvatar } = req.body;
        const file = req.file;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }

        console.log(`📝 Обновление профиля для: ${email}`);
        console.log(`📝 Данные: firstName=${firstName}, lastName=${lastName}, removeAvatar=${removeAvatar}`);

        const normalizedEmail = email.toLowerCase();
        
        await updateUserActivity(normalizedEmail);

        const { data: existingUser, error: checkError } = await supabase
            .from('regular_users')
            .select('*')
            .eq('email', normalizedEmail)
            .single();

        if (checkError || !existingUser) {
            console.error('❌ Пользователь не найден:', normalizedEmail);
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден'
            });
        }

        const updateData = {
            first_name: firstName || existingUser.first_name,
            last_name: lastName || existingUser.last_name,
            updated_at: new Date().toISOString()
        };

        if (removeAvatar === 'true') {
            if (existingUser.avatar_filename) {
                try {
                    await supabase
                        .storage
                        .from(supabaseBucketName)
                        .remove([`avatars/${existingUser.avatar_filename}`]);
                } catch (storageError) {
                    console.warn('⚠️ Ошибка при удалении старого аватара:', storageError.message);
                }
            }
            updateData.avatar_filename = null;
        } 
        else if (file) {
            try {
                console.log('📤 Загрузка нового аватара:', file.originalname);
                
                const fileContent = fs.readFileSync(file.path);
                const fileExt = path.extname(file.originalname);
                const fileName = `avatar_${Date.now()}${fileExt}`;
                const filePath = `avatars/${fileName}`;

                const { error: uploadError } = await supabase
                    .storage
                    .from(supabaseBucketName)
                    .upload(filePath, fileContent, {
                        contentType: file.mimetype,
                        upsert: true
                    });

                if (uploadError) {
                    console.error('❌ Ошибка загрузки аватара:', uploadError);
                    throw uploadError;
                }

                if (existingUser.avatar_filename) {
                    try {
                        await supabase
                            .storage
                            .from(supabaseBucketName)
                            .remove([`avatars/${existingUser.avatar_filename}`]);
                    } catch (storageError) {
                        console.warn('⚠️ Ошибка при удалении старого аватара:', storageError.message);
                    }
                }

                updateData.avatar_filename = fileName;
                console.log('✅ Аватар загружен:', fileName);

                fs.unlink(file.path, (err) => {
                    if (err) console.error('❌ Ошибка удаления временного файла:', err);
                });

            } catch (uploadError) {
                console.error('❌ Ошибка загрузки аватара:', uploadError);
                return res.status(500).json({
                    success: false,
                    error: 'Ошибка загрузки аватара'
                });
            }
        }

        const { data, error: updateError } = await supabase
            .from('regular_users')
            .update(updateData)
            .eq('email', normalizedEmail)
            .select();

        if (updateError) {
            console.error('❌ Ошибка обновления профиля:', updateError);
            throw updateError;
        }

        console.log('✅ Профиль успешно обновлен для:', normalizedEmail);

        let avatarUrl = null;
        if (updateData.avatar_filename) {
            const { data: urlData } = supabase
                .storage
                .from(supabaseBucketName)
                .getPublicUrl(`avatars/${updateData.avatar_filename}`);
            avatarUrl = urlData.publicUrl;
        }

        res.json({
            success: true,
            message: 'Профиль обновлен',
            user: {
                email: normalizedEmail,
                first_name: updateData.first_name,
                last_name: updateData.last_name,
                avatar_filename: updateData.avatar_filename,
                avatar_url: avatarUrl
            }
        });

    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        
        if (req.file && req.file.path) {
            fs.unlink(req.file.path, () => {});
        }
        
        res.status(500).json({
            success: false,
            error: 'Ошибка обновления профиля',
            details: error.message
        });
    }
});

// ===== Получение сообщений группы =====
app.get('/group-messages/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        
        console.log(`📥 Запрос сообщений для группы ID: ${groupId}`);

        const { data: messages, error } = await supabase
            .from('group_messages')
            .select(`
                id,
                group_id,
                sender_email,
                message,
                timestamp,
                file_id,
                duration,
                regular_users!group_messages_sender_email_fkey (
                    first_name,
                    last_name
                ),
                files:file_id (*)
            `)
            .eq('group_id', groupId)
            .order('timestamp', { ascending: true });

        if (error) {
            console.error('❌ Ошибка получения групповых сообщений:', error);
            throw error;
        }

        console.log(`✅ Найдено сообщений: ${messages?.length || 0}`);

        const formattedMessages = (messages || []).map(msg => ({
            id: msg.id,
            group_id: msg.group_id,
            sender_email: msg.sender_email,
            first_name: msg.regular_users?.first_name || '',
            last_name: msg.regular_users?.last_name || '',
            message: msg.message || '',
            timestamp: msg.timestamp,
            duration: msg.duration || 0,
            files: msg.files ? {
                id: msg.files.id,
                file_name: msg.files.file_name,
                file_url: msg.files.file_url,
                file_type: msg.files.file_type,
                file_size: msg.files.file_size
            } : null
        }));

        res.json({
            success: true,
            messages: formattedMessages
        });

    } catch (error) {
        console.error('❌ Ошибка получения групповых сообщений:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка получения сообщений группы',
            details: error.message
        });
    }
});

// ===== Удаление файла =====
app.delete('/files/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

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

        const deleteResult = await deleteFileFromSupabase(fileData.file_path);

        if (!deleteResult.success) {
            console.warn('⚠️ Не удалось удалить файл из хранилища:', deleteResult.error);
        }

        const { error: deleteError } = await supabase
            .from('files')
            .delete()
            .eq('id', fileId);

        if (deleteError) throw deleteError;

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

// ===== Получение групп пользователя =====
app.get('/groups/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        await updateUserActivity(userEmail);

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

// ===== Сохранение пропущенного звонка =====
app.post('/api/calls/missed/save', async (req, res) => {
    try {
        const { roomId, caller, callerName, receiver, callType, startedAt } = req.body;

        if (!roomId || !caller || !receiver) {
            return res.status(400).json({
                success: false,
                error: 'Недостаточно данных для сохранения пропущенного звонка'
            });
        }

        console.log(`💾 Сохранение пропущенного звонка в БД: ${caller} -> ${receiver}`);

        const { data: existingCall, error: checkError } = await supabase
            .from('missed_calls')
            .select('id')
            .eq('room_id', roomId)
            .maybeSingle();

        if (checkError) {
            console.error('❌ Ошибка проверки существующего звонка:', checkError);
        }

        if (existingCall) {
            console.log('⚠️ Звонок уже сохранен в БД');
            return res.json({
                success: true,
                message: 'Звонок уже существует',
                missedCallId: existingCall.id
            });
        }

        const { data, error } = await supabase
            .from('missed_calls')
            .insert([{
                room_id: roomId,
                caller_email: caller.toLowerCase(),
                caller_name: callerName || caller,
                receiver_email: receiver.toLowerCase(),
                call_type: callType || 'audio',
                started_at: startedAt || new Date().toISOString(),
                is_read: false
            }])
            .select();

        if (error) {
            console.error('❌ Ошибка сохранения пропущенного звонка:', error);
            return res.status(500).json({
                success: false,
                error: 'Ошибка сохранения в БД'
            });
        }

        console.log(`✅ Пропущенный звонок сохранен с ID: ${data[0].id}`);

        res.json({
            success: true,
            missedCallId: data[0].id,
            message: 'Пропущенный звонок сохранен'
        });

    } catch (error) {
        console.error('❌ Ошибка в /api/calls/missed/save:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Получение пропущенных звонков =====
app.get('/api/calls/missed/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();

        console.log(`📞 Запрос пропущенных звонков для: ${normalizedEmail}`);
        
        await updateUserActivity(normalizedEmail);

        const { data, error } = await supabase
            .from('missed_calls')
            .select('*')
            .eq('receiver_email', normalizedEmail)
            .order('started_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('❌ Ошибка получения пропущенных звонков:', error);
            throw error;
        }

        console.log(`✅ Найдено пропущенных звонков: ${data?.length || 0}`);

        const missedCalls = (data || []).map(call => ({
            historyId: call.id.toString(),
            roomId: call.room_id,
            caller: call.caller_email,
            callerName: call.caller_name,
            callType: call.call_type,
            startedAt: call.started_at,
            status: 'missed',
            isRead: call.is_read,
            createdAt: call.created_at
        }));

        res.json({
            success: true,
            missedCalls: missedCalls
        });

    } catch (error) {
        console.error('❌ Ошибка получения пропущенных звонков:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Отметить пропущенные звонки как прочитанные =====
app.post('/api/calls/missed/mark-read', async (req, res) => {
    try {
        const { userEmail, callIds } = req.body;

        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }

        console.log(`📖 Отметка пропущенных звонков как прочитанных для: ${userEmail}`);

        let query = supabase
            .from('missed_calls')
            .update({ is_read: true })
            .eq('receiver_email', userEmail.toLowerCase())
            .eq('is_read', false);

        if (callIds && Array.isArray(callIds) && callIds.length > 0) {
            query = query.in('id', callIds);
        }

        const { data, error } = await query.select();

        if (error) {
            console.error('❌ Ошибка обновления статуса:', error);
            throw error;
        }

        console.log(`✅ Отмечено как прочитанные: ${data?.length || 0} звонков`);

        res.json({
            success: true,
            updated: data?.length || 0,
            message: 'Статус обновлен'
        });

    } catch (error) {
        console.error('❌ Ошибка отметки звонков как прочитанных:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Удаление старых пропущенных звонков =====
app.delete('/api/calls/missed/cleanup', async (req, res) => {
    try {
        const { days } = req.query;
        const daysToKeep = parseInt(days) || 30;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        console.log(`🧹 Очистка пропущенных звонков старше ${daysToKeep} дней`);

        const { data, error } = await supabase
            .from('missed_calls')
            .delete()
            .lt('started_at', cutoffDate.toISOString())
            .select();

        if (error) {
            console.error('❌ Ошибка очистки:', error);
            throw error;
        }

        console.log(`✅ Удалено старых пропущенных звонков: ${data?.length || 0}`);

        res.json({
            success: true,
            deleted: data?.length || 0,
            message: `Удалено звонков старше ${daysToKeep} дней`
        });

    } catch (error) {
        console.error('❌ Ошибка очистки пропущенных звонков:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Очистка истории чата =====
app.post('/clear-chat', async (req, res) => {
    try {
        const { userEmail, friendEmail } = req.body;
        
        if (!userEmail || !friendEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email пользователя и друга обязательны'
            });
        }
        
        const normalizedUserEmail = userEmail.toLowerCase();
        const normalizedFriendEmail = friendEmail.toLowerCase();
        
        console.log(`🧹 Очистка чата между ${normalizedUserEmail} и ${normalizedFriendEmail}`);
        
        await updateUserActivity(normalizedUserEmail);
        
        const { data: messages, error: selectError } = await supabase
            .from('messages')
            .select('id, file_id')
            .or(`and(sender_email.eq.${normalizedUserEmail},receiver_email.eq.${normalizedFriendEmail}),and(sender_email.eq.${normalizedFriendEmail},receiver_email.eq.${normalizedUserEmail})`);
        
        if (selectError) {
            console.error('❌ Ошибка при поиске сообщений:', selectError);
            throw selectError;
        }
        
        console.log(`📊 Найдено сообщений: ${messages?.length || 0}`);
        
        if (messages && messages.length > 0) {
            const fileIds = messages
                .filter(msg => msg.file_id !== null)
                .map(msg => msg.file_id);
            
            console.log(`📎 Найдено файлов: ${fileIds.length}`);
            
            const { error: deleteMessagesError } = await supabase
                .from('messages')
                .delete()
                .or(`and(sender_email.eq.${normalizedUserEmail},receiver_email.eq.${normalizedFriendEmail}),and(sender_email.eq.${normalizedFriendEmail},receiver_email.eq.${normalizedUserEmail})`);
            
            if (deleteMessagesError) {
                console.error('❌ Ошибка при удалении сообщений:', deleteMessagesError);
                throw deleteMessagesError;
            }
            
            if (fileIds.length > 0) {
                for (const fileId of fileIds) {
                    try {
                        const { data: fileData } = await supabase
                            .from('files')
                            .select('file_path')
                            .eq('id', fileId)
                            .single();
                        
                        if (fileData && fileData.file_path) {
                            await supabase
                                .storage
                                .from(supabaseBucketName)
                                .remove([fileData.file_path]);
                        }
                        
                        await supabase
                            .from('files')
                            .delete()
                            .eq('id', fileId);
                            
                        console.log(`✅ Удален файл ID ${fileId}`);
                    } catch (fileError) {
                        console.error(`❌ Ошибка при удалении файла ID ${fileId}:`, fileError);
                    }
                }
            }
        }
        
        console.log('✅ Чат успешно очищен');
        
        res.json({
            success: true,
            message: 'История чата очищена'
        });
        
    } catch (error) {
        console.error('❌ Ошибка очистки чата:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка при очистке чата',
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

        const uploadedAt = new Date(data.uploaded_at);
        const now = new Date();
        const daysOld = Math.floor((now - uploadedAt) / (1000 * 60 * 60 * 24));
        
        console.log(`📎 Информация о файле ID ${fileId}: ${data.file_name}, возраст: ${daysOld} дней`);

        res.json({
            success: true,
            file: {
                ...data,
                days_old: daysOld,
                will_be_deleted_at: new Date(uploadedAt.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString()
            }
        });
    } catch (error) {
        console.error('❌ Ошибка получения информации о файле:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ===== Статус сервера =====
app.get('/api/status', (req, res) => {
    const onlineUsers = Array.from(userLastActivity.entries())
        .filter(([_, lastActivity]) => Date.now() - lastActivity < ACTIVITY_TIMEOUT)
        .length;
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        serverId: SERVER_ID,
        stats: {
            activeRooms: rooms.size,
            totalUsers: users.size,
            activeCalls: activeCalls.size,
            onlineUsers: onlineUsers,
            totalCallsToday: getTodayCallsCount()
        },
        activityTracking: {
            timeout: ACTIVITY_TIMEOUT / 1000 / 60 + ' минут',
            trackedUsers: userLastActivity.size
        },
        callTimeouts: {
            active: callTimeouts.size
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

// ===== Создать комнату =====
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

// ==================== ИСПРАВЛЕННЫЕ ЭНДПОИНТЫ ДЛЯ ЗВОНКОВ ====================

// ===== Инициирование звонка =====
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
        
        await updateUserActivity(callerEmail);
        
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
        
        // ИСПРАВЛЕНИЕ: Улучшенное сохранение таймаута
        const timeoutId = setTimeout(async () => {
            const call = activeCalls.get(roomId);
            
            // Проверяем, что звонок все еще в статусе ringing
            if (call && call.status === 'ringing') {
                console.log(`⏰ Таймаут звонка ${roomId} - никто не ответил (прошло 30 секунд)`);
                
                // Обновляем статус звонка
                call.status = 'missed';
                call.endedAt = new Date().toISOString();
                
                // Сохраняем в историю
                const missedCall = {
                    ...call,
                    endedBy: 'timeout',
                    endTime: call.endedAt,
                    status: 'missed',
                    duration: 0
                };
                
                const historyId = 'hist_' + Date.now();
                callHistory.set(historyId, missedCall);
                
                // Удаляем из активных звонков
                activeCalls.delete(roomId);
                
                // Уведомляем звонящего
                const callerSocketId = emailToSocket.get(callerEmail.toLowerCase());
                if (callerSocketId) {
                    io.to(callerSocketId).emit('call-missed', {
                        type: 'call-missed',
                        roomId: roomId,
                        receiver: receiverEmail,
                        timestamp: new Date().toISOString()
                    });
                }
                
                // Отправляем уведомление о пропущенном звонке
                await sendMissedCallNotification(
                    receiverEmail,
                    callerEmail,
                    callType || 'audio',
                    roomId
                );
            }
            
            // Всегда удаляем таймаут из хранилища после выполнения
            callTimeouts.delete(roomId);
            console.log(`⏱️ Таймаут для комнаты ${roomId} удален из хранилища`);
            
        }, 30000);
        
        // Сохраняем таймаут с дополнительной информацией для отладки
        callTimeouts.set(roomId, {
            timeoutId,
            createdAt: new Date().toISOString(),
            caller: callerEmail,
            receiver: receiverEmail
        });
        
        console.log(`⏱️ Таймаут установлен для комнаты ${roomId}:`, {
            timeoutId: timeoutId,
            createdAt: new Date().toISOString(),
            caller: callerEmail,
            receiver: receiverEmail
        });
        
        // Отправляем FCM уведомление
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
        
        // Отправляем сокет-уведомление, если получатель онлайн
        const receiverSocketId = emailToSocket.get(receiverEmail.toLowerCase());
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
        
        console.log(`✅ Звонок инициирован, комната: ${roomId}, таймаут установлен на 30 сек`);
        
        res.json({
            success: true,
            roomId: roomId,
            message: 'Звонок инициирован',
            isReceiverOnline: !!receiverSocketId,
            fcmSent: fcmSent,
            timeoutSeconds: 30
        });
        
    } catch (error) {
        console.error('❌ Ошибка инициации звонка:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Принятие звонка (ИСПРАВЛЕНО) =====
app.post('/api/calls/accept', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId || !userEmail) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты и email обязательны'
            });
        }
        
        console.log(`📞 Принятие звонка: ${userEmail} в комнате ${roomId}`);
        
        await updateUserActivity(userEmail);
        
        // Получаем данные звонка
        const callData = activeCalls.get(roomId);
        
        if (!callData) {
            return res.status(404).json({
                success: false,
                error: 'Звонок не найден или уже завершен'
            });
        }
        
        // Проверяем, что пользователь - получатель звонка
        if (callData.receiver.toLowerCase() !== userEmail.toLowerCase()) {
            return res.status(403).json({
                success: false,
                error: 'Вы не можете принять этот звонок'
            });
        }
        
        // ИСПРАВЛЕНИЕ: Очищаем таймаут ДО изменения статуса
        const timeoutData = callTimeouts.get(roomId);
        if (timeoutData) {
            console.log(`⏱️ Найден таймаут для комнаты ${roomId}:`, timeoutData);
            
            // Очищаем таймаут
            clearTimeout(timeoutData.timeoutId);
            callTimeouts.delete(roomId);
            
            console.log(`⏱️ Таймаут для комнаты ${roomId} очищен`);
        } else {
            console.log(`⚠️ Таймаут для комнаты ${roomId} не найден в хранилище`);
        }
        
        // Теперь меняем статус звонка
        callData.status = 'connected';
        callData.participants.push(userEmail);
        callData.answeredAt = new Date().toISOString();
        activeCalls.set(roomId, callData);
        
        // Уведомляем звонящего
        const callerSocketId = emailToSocket.get(callData.caller.toLowerCase());
        
        if (callerSocketId) {
            io.to(callerSocketId).emit('call-accepted', {
                type: 'call-accepted',
                roomId: roomId,
                receiver: userEmail,
                timestamp: new Date().toISOString()
            });
            console.log(`📱 Уведомление об принятии отправлено звонящему ${callData.caller}`);
        }
        
        console.log(`✅ Звонок ${roomId} ПРИНЯТ пользователем ${userEmail}`);
        console.log(`📊 Статус звонка обновлен: ringing -> connected`);
        
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

// ===== Отклонение звонка (ИСПРАВЛЕНО) =====
app.post('/api/calls/reject', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId || !userEmail) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты и email обязательны'
            });
        }
        
        console.log(`❌ Отклонение звонка: ${userEmail} в комнате ${roomId}`);
        
        await updateUserActivity(userEmail);
        
        // Получаем данные звонка
        const callData = activeCalls.get(roomId);
        
        if (callData) {
            // ИСПРАВЛЕНИЕ: Очищаем таймаут
            const timeoutData = callTimeouts.get(roomId);
            if (timeoutData) {
                clearTimeout(timeoutData.timeoutId);
                callTimeouts.delete(roomId);
                console.log(`⏱️ Таймаут для комнаты ${roomId} очищен при отклонении`);
            }
            
            // Уведомляем звонящего
            const callerSocketId = emailToSocket.get(callData.caller.toLowerCase());
            
            if (callerSocketId) {
                io.to(callerSocketId).emit('call-rejected', {
                    type: 'call-rejected',
                    roomId: roomId,
                    receiver: userEmail,
                    timestamp: new Date().toISOString()
                });
            }
            
            // Сохраняем в историю
            const rejectedCall = {
                ...callData,
                status: 'rejected',
                endedBy: userEmail,
                endTime: new Date().toISOString(),
                duration: 0
            };
            
            const historyId = 'hist_' + Date.now();
            callHistory.set(historyId, rejectedCall);
            
            // Удаляем из активных звонков
            activeCalls.delete(roomId);
            
            console.log(`❌ Звонок ${roomId} ОТКЛОНЕН пользователем ${userEmail}`);
        } else {
            console.log(`⚠️ Звонок ${roomId} не найден при отклонении`);
        }
        
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

// ===== Завершение звонка =====
app.post('/api/calls/end', async (req, res) => {
    try {
        const { roomId, userEmail } = req.body;
        
        if (!roomId) {
            return res.status(400).json({
                success: false,
                error: 'ID комнаты обязателен'
            });
        }
        
        console.log(`📴 Завершение звонка: ${roomId} пользователем ${userEmail || 'system'}`);
        
        if (userEmail) {
            await updateUserActivity(userEmail);
        }
        
        // ИСПРАВЛЕНИЕ: Очищаем таймаут при завершении
        const timeoutData = callTimeouts.get(roomId);
        if (timeoutData) {
            clearTimeout(timeoutData.timeoutId);
            callTimeouts.delete(roomId);
            console.log(`⏱️ Таймаут для комнаты ${roomId} очищен при завершении`);
        }
        
        const callData = activeCalls.get(roomId);
        
        if (callData) {
            // Уведомляем всех участников
            callData.participants.forEach(email => {
                if (email !== userEmail) {
                    const participantSocketId = emailToSocket.get(email.toLowerCase());
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
            
            // Удаляем из активных звонков
            activeCalls.delete(roomId);
            
            console.log(`📴 Звонок ${roomId} завершен, длительность: ${endedCall.duration}`);
        }
        
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

// ===== Получить информацию о звонке =====
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
        
        // Добавляем информацию о таймауте для отладки
        const timeoutData = callTimeouts.get(roomId);
        
        res.json({
            success: true,
            call: callData,
            timeout: timeoutData ? {
                exists: true,
                createdAt: timeoutData.createdAt
            } : {
                exists: false
            }
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения информации о звонке:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Получить активные звонки пользователя =====
app.get('/api/calls/user/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        await updateUserActivity(normalizedEmail);
        
        const userCalls = [];
        
        for (const [roomId, callData] of activeCalls.entries()) {
            if (callData.caller.toLowerCase() === normalizedEmail || 
                callData.receiver.toLowerCase() === normalizedEmail || 
                (callData.participants && callData.participants.some(p => p.toLowerCase() === normalizedEmail))) {
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

// ===== ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ СТАТУСАМИ =====

// ===== Получить статус пользователя =====
app.get('/api/status/:email', async (req, res) => {
    try {
        const email = req.params.email.toLowerCase();
        
        await updateUserActivity(email);
        
        const lastActivity = userLastActivity.get(email);
        const isOnline = lastActivity ? (Date.now() - lastActivity) < ACTIVITY_TIMEOUT : false;
        
        const { data, error } = await supabase
            .from('user_presence')
            .select('status, last_seen, socket_id, server_id')
            .eq('user_email', email)
            .maybeSingle();
        
        res.json({
            success: true,
            email: email,
            status: isOnline ? 'online' : 'offline',
            lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
            database: data || null,
            isOnline: isOnline,
            activityTimeout: ACTIVITY_TIMEOUT / 1000 / 60 + ' минут'
        });
    } catch (error) {
        console.error('❌ Ошибка получения статуса:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Получить статусы нескольких пользователей =====
app.post('/api/status/batch', async (req, res) => {
    try {
        const { emails } = req.body;
        
        if (!emails || !Array.isArray(emails)) {
            return res.status(400).json({
                success: false,
                error: 'Требуется массив emails'
            });
        }
        
        const now = Date.now();
        const statuses = {};
        
        for (const email of emails) {
            const normalizedEmail = email.toLowerCase();
            const lastActivity = userLastActivity.get(normalizedEmail);
            const isOnline = lastActivity ? (now - lastActivity) < ACTIVITY_TIMEOUT : false;
            
            statuses[normalizedEmail] = {
                status: isOnline ? 'online' : 'offline',
                lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null
            };
        }
        
        res.json({
            success: true,
            statuses: statuses,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Ошибка получения статусов:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Принудительно обновить активность пользователя =====
app.post('/api/activity/ping', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }
        
        await updateUserActivity(email);
        
        res.json({
            success: true,
            message: 'Активность обновлена',
            email: email.toLowerCase(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Ошибка обновления активности:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Получить всех онлайн пользователей =====
app.get('/api/status/online/all', async (req, res) => {
    try {
        const now = Date.now();
        const onlineUsers = [];
        
        for (const [email, lastActivity] of userLastActivity.entries()) {
            if (now - lastActivity < ACTIVITY_TIMEOUT) {
                const userInfo = await getUserInfo(email);
                onlineUsers.push({
                    email: email,
                    name: userInfo ? `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim() : email,
                    lastActivity: new Date(lastActivity).toISOString(),
                    activeSeconds: Math.round((now - lastActivity) / 1000)
                });
            }
        }
        
        onlineUsers.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
        
        res.json({
            success: true,
            total: onlineUsers.length,
            users: onlineUsers,
            timeout: ACTIVITY_TIMEOUT / 1000 / 60 + ' минут'
        });
    } catch (error) {
        console.error('❌ Ошибка получения онлайн пользователей:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== ЭНДПОИНТЫ ДЛЯ НАСТРОЕК КОНФИДЕНЦИАЛЬНОСТИ =====

// ===== Получить настройки конфиденциальности пользователя =====
app.get('/api/privacy/settings/:email', async (req, res) => {
    try {
        const email = req.params.email.toLowerCase();

        await updateUserActivity(email);

        const user = await getUserInfo(email);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден'
            });
        }

        let { data: settings, error } = await supabase
            .from('privacy_settings')
            .select('*')
            .eq('user_email', email)
            .maybeSingle();

        if (error) throw error;

        if (!settings) {
            const { data: newSettings, error: insertError } = await supabase
                .from('privacy_settings')
                .insert([{
                    user_email: email,
                    is_online_status_visible: true,
                    is_last_seen_visible: true,
                    is_profile_photo_visible: true,
                    is_read_receipts_enabled: true
                }])
                .select()
                .single();

            if (insertError) throw insertError;
            settings = newSettings;
        }

        const { count, error: countError } = await supabase
            .from('blocked_users')
            .select('*', { count: 'exact', head: true })
            .eq('user_email', email);

        if (countError) throw countError;

        res.json({
            success: true,
            settings: {
                isOnlineStatusVisible: settings.is_online_status_visible,
                isLastSeenVisible: settings.is_last_seen_visible,
                isProfilePhotoVisible: settings.is_profile_photo_visible,
                isReadReceiptsEnabled: settings.is_read_receipts_enabled,
                blockedUsersCount: count || 0
            }
        });

    } catch (error) {
        console.error('❌ Ошибка получения настроек конфиденциальности:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Обновить настройки конфиденциальности =====
app.post('/api/privacy/settings/update', async (req, res) => {
    try {
        const { 
            userEmail, 
            isOnlineStatusVisible, 
            isLastSeenVisible, 
            isProfilePhotoVisible, 
            isReadReceiptsEnabled 
        } = req.body;

        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }

        const normalizedEmail = userEmail.toLowerCase();

        await updateUserActivity(normalizedEmail);

        const user = await getUserInfo(normalizedEmail);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден'
            });
        }

        const { data: existingSettings } = await supabase
            .from('privacy_settings')
            .select('id')
            .eq('user_email', normalizedEmail)
            .maybeSingle();

        let result;
        
        if (existingSettings) {
            const { data, error } = await supabase
                .from('privacy_settings')
                .update({
                    is_online_status_visible: isOnlineStatusVisible !== undefined ? isOnlineStatusVisible : true,
                    is_last_seen_visible: isLastSeenVisible !== undefined ? isLastSeenVisible : true,
                    is_profile_photo_visible: isProfilePhotoVisible !== undefined ? isProfilePhotoVisible : true,
                    is_read_receipts_enabled: isReadReceiptsEnabled !== undefined ? isReadReceiptsEnabled : true
                })
                .eq('user_email', normalizedEmail)
                .select()
                .single();

            if (error) throw error;
            result = data;
        } else {
            const { data, error } = await supabase
                .from('privacy_settings')
                .insert([{
                    user_email: normalizedEmail,
                    is_online_status_visible: isOnlineStatusVisible !== undefined ? isOnlineStatusVisible : true,
                    is_last_seen_visible: isLastSeenVisible !== undefined ? isLastSeenVisible : true,
                    is_profile_photo_visible: isProfilePhotoVisible !== undefined ? isProfilePhotoVisible : true,
                    is_read_receipts_enabled: isReadReceiptsEnabled !== undefined ? isReadReceiptsEnabled : true
                }])
                .select()
                .single();

            if (error) throw error;
            result = data;
        }

        console.log(`✅ Настройки конфиденциальности обновлены для ${normalizedEmail}`);

        res.json({
            success: true,
            message: 'Настройки сохранены',
            settings: {
                isOnlineStatusVisible: result.is_online_status_visible,
                isLastSeenVisible: result.is_last_seen_visible,
                isProfilePhotoVisible: result.is_profile_photo_visible,
                isReadReceiptsEnabled: result.is_read_receipts_enabled
            }
        });

    } catch (error) {
        console.error('❌ Ошибка обновления настроек конфиденциальности:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Получить список заблокированных пользователей =====
app.get('/api/privacy/blocked/:email', async (req, res) => {
    try {
        const email = req.params.email.toLowerCase();

        await updateUserActivity(email);

        const { data, error } = await supabase
            .from('blocked_users')
            .select(`
                blocked_user_email,
                blocked_at,
                regular_users!blocked_users_blocked_user_email_fkey (
                    first_name,
                    last_name,
                    email
                )
            `)
            .eq('user_email', email)
            .order('blocked_at', { ascending: false });

        if (error) throw error;

        const blockedUsers = (data || []).map(item => ({
            email: item.blocked_user_email,
            name: item.regular_users ? 
                `${item.regular_users.first_name || ''} ${item.regular_users.last_name || ''}`.trim() : 
                item.blocked_user_email,
            blockedAt: item.blocked_at
        }));

        res.json({
            success: true,
            blockedUsers
        });

    } catch (error) {
        console.error('❌ Ошибка получения заблокированных пользователей:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Заблокировать пользователя =====
app.post('/api/privacy/blocked/add', async (req, res) => {
    try {
        const { userEmail, blockedUserEmail } = req.body;

        if (!userEmail || !blockedUserEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email пользователя и блокируемого пользователя обязательны'
            });
        }

        const normalizedUserEmail = userEmail.toLowerCase();
        const normalizedBlockedEmail = blockedUserEmail.toLowerCase();

        if (normalizedUserEmail === normalizedBlockedEmail) {
            return res.status(400).json({
                success: false,
                error: 'Нельзя заблокировать самого себя'
            });
        }

        await updateUserActivity(normalizedUserEmail);

        const blockedUser = await getUserInfo(normalizedBlockedEmail);
        if (!blockedUser) {
            return res.status(404).json({
                success: false,
                error: 'Блокируемый пользователь не найден'
            });
        }

        const { data, error } = await supabase
            .from('blocked_users')
            .upsert({
                user_email: normalizedUserEmail,
                blocked_user_email: normalizedBlockedEmail
            }, {
                onConflict: 'user_email,blocked_user_email',
                ignoreDuplicates: true
            })
            .select();

        if (error) throw error;

        console.log(`🔨 Пользователь ${normalizedUserEmail} заблокировал ${normalizedBlockedEmail}`);

        res.json({
            success: true,
            message: 'Пользователь заблокирован'
        });

    } catch (error) {
        console.error('❌ Ошибка блокировки пользователя:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Разблокировать пользователя =====
app.delete('/api/privacy/blocked/remove', async (req, res) => {
    try {
        const { userEmail, blockedUserEmail } = req.body;

        if (!userEmail || !blockedUserEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email пользователя и блокируемого пользователя обязательны'
            });
        }

        const normalizedUserEmail = userEmail.toLowerCase();
        const normalizedBlockedEmail = blockedUserEmail.toLowerCase();

        await updateUserActivity(normalizedUserEmail);

        const { error } = await supabase
            .from('blocked_users')
            .delete()
            .eq('user_email', normalizedUserEmail)
            .eq('blocked_user_email', normalizedBlockedEmail);

        if (error) throw error;

        console.log(`✅ Пользователь ${normalizedUserEmail} разблокировал ${normalizedBlockedEmail}`);

        res.json({
            success: true,
            message: 'Пользователь разблокирован'
        });

    } catch (error) {
        console.error('❌ Ошибка разблокировки пользователя:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Запрос на экспорт данных =====
app.post('/api/privacy/export/request', async (req, res) => {
    try {
        const { userEmail } = req.body;

        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }

        const normalizedEmail = userEmail.toLowerCase();

        await updateUserActivity(normalizedEmail);

        const { data, error } = await supabase
            .from('data_export_requests')
            .insert([{
                user_email: normalizedEmail,
                status: 'pending'
            }])
            .select()
            .single();

        if (error) throw error;

        console.log(`📦 Запрос на экспорт данных от ${normalizedEmail}`);

        prepareDataExport(normalizedEmail, data.id);

        res.json({
            success: true,
            message: 'Запрос на экспорт данных принят',
            requestId: data.id,
            estimatedTime: '48 часов'
        });

    } catch (error) {
        console.error('❌ Ошибка создания запроса на экспорт:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Запрос на удаление данных =====
app.post('/api/privacy/delete/request', async (req, res) => {
    try {
        const { userEmail } = req.body;

        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email обязателен'
            });
        }

        const normalizedEmail = userEmail.toLowerCase();

        await updateUserActivity(normalizedEmail);

        const { data, error } = await supabase
            .from('data_deletion_requests')
            .insert([{
                user_email: normalizedEmail,
                status: 'pending'
            }])
            .select()
            .single();

        if (error) throw error;

        console.log(`🗑️ Запрос на удаление данных от ${normalizedEmail}`);

        res.json({
            success: true,
            message: 'Запрос на удаление данных принят',
            requestId: data.id
        });

    } catch (error) {
        console.error('❌ Ошибка создания запроса на удаление:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===== Вспомогательная функция для подготовки экспорта данных =====
async function prepareDataExport(userEmail, requestId) {
    try {
        console.log(`🔄 Начало подготовки экспорта данных для ${userEmail}`);

        await supabase
            .from('data_export_requests')
            .update({ status: 'processing' })
            .eq('id', requestId);

        const userData = await getUserInfo(userEmail);
        
        const { data: messages } = await supabase
            .from('messages')
            .select('*')
            .or(`sender_email.eq.${userEmail},receiver_email.eq.${userEmail}`)
            .order('timestamp');

        const { data: groupMessages } = await supabase
            .from('group_messages')
            .select('*')
            .eq('sender_email', userEmail)
            .order('timestamp');

        const { data: files } = await supabase
            .from('files')
            .select('*')
            .eq('sender_email', userEmail);

        const exportData = {
            user: userData,
            messages: messages || [],
            groupMessages: groupMessages || [],
            files: files || [],
            exportedAt: new Date().toISOString()
        };

        const fileName = `export_${userEmail}_${Date.now()}.json`;
        const filePath = `exports/${fileName}`;
        
        await supabase
            .from('data_export_requests')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                file_url: `https://${supabaseUrl}/storage/v1/object/public/${supabaseBucketName}/exports/${fileName}`
            })
            .eq('id', requestId);

        console.log(`✅ Экспорт данных для ${userEmail} завершен`);

    } catch (error) {
        console.error('❌ Ошибка подготовки экспорта данных:', error);
        
        await supabase
            .from('data_export_requests')
            .update({
                status: 'failed',
                completed_at: new Date().toISOString()
            })
            .eq('id', requestId);
    }
}

// ===== FCM ЭНДПОИНТЫ =====

// ===== Сохранить FCM токен =====
app.post('/api/fcm/token', async (req, res) => {
    try {
        const { userEmail, fcmToken } = req.body;
        
        if (!userEmail || !fcmToken) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email и токен обязательны' 
            });
        }

        await updateUserActivity(userEmail);

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

// ===== Проверить FCM токен =====
app.get('/api/fcm/check/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        console.log(`🔍 Проверка FCM токена для: ${normalizedEmail}`);
        
        await updateUserActivity(normalizedEmail);
        
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

// ===== Тестовый эндпоинт для FCM =====
app.post('/api/fcm/test', async (req, res) => {
    try {
        const { userEmail, title, body } = req.body;
        
        if (!userEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email обязателен' 
            });
        }

        await updateUserActivity(userEmail);

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

        await updateUserActivity(email);

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

// ===== Получение информации о пользователе =====
app.get('/user/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email).toLowerCase();
        console.log('🔍 Поиск пользователя по email:', email);

        await updateUserActivity(email);

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

// ===== Получение чатов пользователя =====
app.get('/chats/:userEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();

        console.log('🔄 Получение чатов для:', userEmail);

        await updateUserActivity(userEmail);

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

// ===== Получение сообщений между пользователями =====
app.get('/messages/:userEmail/:friendEmail', async (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        const friendEmail = req.params.friendEmail.toLowerCase();

        await updateUserActivity(userEmail);

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

        await updateUserActivity(senderEmail);

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

        const senderName = `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() || senderEmail;
        await sendFCMNotificationForMessage(
            receiverEmail,
            senderName,
            senderEmail,
            message || '',
            data[0].id,
            false
        );

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
 * Обновление длительности аудио-сообщения
 */
app.post('/update-message-duration', async (req, res) => {
    try {
        const { messageId, duration } = req.body;

        const { error } = await supabase
            .from('messages')
            .update({ duration: duration })
            .eq('id', messageId);

        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка обновления длительности:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Обновление длительности группового аудио-сообщения
 */
app.post('/update-group-message-duration', async (req, res) => {
    try {
        const { messageId, duration } = req.body;

        const { error } = await supabase
            .from('group_messages')
            .update({ duration: duration })
            .eq('id', messageId);

        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка обновления длительности группового:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Получение информации об истечении срока аудио
 */
app.get('/audio/:type/:messageId/expiration', async (req, res) => {
    try {
        const { type, messageId } = req.params;
        
        let query;
        if (type === 'group') {
            query = supabase
                .from('group_messages')
                .select('timestamp, files!group_messages_file_id_fkey(file_name, file_path, uploaded_at)')
                .eq('id', messageId)
                .single();
        } else {
            query = supabase
                .from('messages')
                .select('timestamp, files!messages_file_id_fkey(file_name, file_path, uploaded_at)')
                .eq('id', messageId)
                .single();
        }

        const { data, error } = await query;

        if (error) throw error;

        const uploadedAt = data.files?.uploaded_at || data.timestamp;
        const uploadedDate = new Date(uploadedAt);
        const now = new Date();
        const ageInDays = Math.floor((now - uploadedDate) / (1000 * 60 * 60 * 24));
        const daysLeft = Math.max(0, 10 - ageInDays);
        const willBeDeletedAt = new Date(uploadedDate.getTime() + 10 * 24 * 60 * 60 * 1000);

        res.json({
            success: true,
            uploadedAt: uploadedAt,
            ageInDays: ageInDays,
            daysLeft: daysLeft,
            willBeDeletedAt: willBeDeletedAt.toISOString(),
            isExpired: ageInDays >= 10
        });

    } catch (error) {
        console.error('❌ Ошибка получения информации об удалении:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== Отправка группового сообщения =====
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

        await updateUserActivity(senderEmail);

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

        const { data: groupData } = await supabase
            .from('groups')
            .select('name')
            .eq('id', groupId)
            .single();

        const { data: members, error: membersError } = await supabase
            .from('group_members')
            .select('user_email')
            .eq('group_id', groupId);

        if (!membersError && members) {
            const senderName = `${senderInfo.first_name || ''} ${senderInfo.last_name || ''}`.trim() || senderEmail;
            const groupName = groupData?.name || 'Группа';
            
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

        await updateUserActivity(normalizedUserEmail);

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

app.get('/api/debug/timeouts', (req, res) => {
    const timeouts = [];
    for (const [roomId, data] of callTimeouts.entries()) {
        timeouts.push({
            roomId,
            createdAt: data.createdAt,
            caller: data.caller,
            receiver: data.receiver,
            age: Date.now() - new Date(data.createdAt).getTime()
        });
    }
    res.json({
        success: true,
        total: timeouts.length,
        timeouts
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

app.get('/api/debug/activity', (req, res) => {
    const now = Date.now();
    const activityData = Array.from(userLastActivity.entries()).map(([email, lastActivity]) => ({
        email,
        lastActivity: new Date(lastActivity).toISOString(),
        isOnline: now - lastActivity < ACTIVITY_TIMEOUT,
        secondsAgo: Math.round((now - lastActivity) / 1000)
    }));
    
    res.json({
        success: true,
        total: activityData.length,
        users: activityData,
        timeout: ACTIVITY_TIMEOUT / 1000 / 60 + ' минут'
    });
});

// ==================== АДМИНИСТРАТИВНАЯ ПАНЕЛЬ ====================

// Конфигурация администраторов
const ADMIN_EMAILS = process.env.ADMIN_EMAILS ? 
    process.env.ADMIN_EMAILS.split(',') : 
    ['admin@beresta.ru'];

function isAdmin(req, res, next) {
    const userEmail = req.headers['x-admin-email'] || req.body.adminEmail || req.query.adminEmail;
    
    if (!userEmail) {
        return res.status(401).json({ success: false, error: 'Требуется авторизация администратора' });
    }
    
    if (!ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Нет прав администратора' });
    }
    
    req.adminEmail = userEmail.toLowerCase();
    next();
}

// Хранилище для запланированных уведомлений
const scheduledNotifications = new Map();

// Функция выполнения массовой отправки
async function executeMassNotification(notification) {
    const { title, body, recipientType, recipients } = notification;
    
    console.log(`📢 Начало массовой рассылки: "${title}"`);
    
    try {
        let targetEmails = [];
        
        if (recipientType === 'all') {
            const { data: users } = await supabase.from('regular_users').select('email');
            targetEmails = (users || []).map(u => u.email);
        } else if (recipientType === 'online') {
            const now = Date.now();
            for (const [email, lastActivity] of userLastActivity.entries()) {
                if (now - lastActivity < ACTIVITY_TIMEOUT) {
                    targetEmails.push(email);
                }
            }
        } else if (recipientType === 'selected') {
            targetEmails = recipients;
        }
        
        console.log(`📊 Найдено получателей: ${targetEmails.length}`);
        
        let sent = 0;
        let failed = 0;
        
        for (const email of targetEmails) {
            try {
                const { data: tokenData } = await supabase
                    .from('user_fcm_tokens')
                    .select('fcm_token')
                    .eq('user_email', email.toLowerCase())
                    .order('created_at', { ascending: false })
                    .limit(1);
                
                if (!tokenData || tokenData.length === 0) {
                    failed++;
                    continue;
                }
                
                const message = {
                    notification: { title, body },
                    data: {
                        type: 'admin_notification',
                        title: title,
                        body: body,
                        timestamp: new Date().toISOString()
                    },
                    token: tokenData[0].fcm_token,
                    android: { priority: 'high' }
                };
                
                await admin.messaging().send(message);
                sent++;
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                failed++;
                console.error(`❌ Ошибка отправки для ${email}:`, error.message);
            }
        }
        
        console.log(`✅ Массовая рассылка завершена: отправлено ${sent}, ошибок ${failed}`);
        return { sent, failed, total: targetEmails.length };
        
    } catch (error) {
        console.error('❌ Ошибка выполнения массовой рассылки:', error);
        return { sent: 0, failed: 0, total: 0, error: error.message };
    }
}

// ==================== АДМИНИСТРАТИВНАЯ ПАНЕЛЬ ====================

// Конфигурация администраторов
const ADMIN_EMAILS = process.env.ADMIN_EMAILS ? 
    process.env.ADMIN_EMAILS.split(',') : 
    ['admin@beresta.ru'];

function isAdmin(req, res, next) {
    const userEmail = req.headers['x-admin-email'] || req.body.adminEmail || req.query.adminEmail;
    
    if (!userEmail) {
        return res.status(401).json({ success: false, error: 'Требуется авторизация администратора' });
    }
    
    if (!ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Нет прав администратора' });
    }
    
    req.adminEmail = userEmail.toLowerCase();
    next();
}

// Хранилище для запланированных уведомлений
const scheduledNotifications = new Map();

// Функция выполнения массовой отправки
async function executeMassNotification(notification) {
    const { title, body, recipientType, recipients } = notification;
    
    console.log(`📢 Начало массовой рассылки: "${title}"`);
    
    try {
        let targetEmails = [];
        
        if (recipientType === 'all') {
            const { data: users } = await supabase.from('regular_users').select('email');
            targetEmails = (users || []).map(u => u.email);
        } else if (recipientType === 'online') {
            const now = Date.now();
            for (const [email, lastActivity] of userLastActivity.entries()) {
                if (now - lastActivity < ACTIVITY_TIMEOUT) {
                    targetEmails.push(email);
                }
            }
        } else if (recipientType === 'selected') {
            targetEmails = recipients;
        }
        
        console.log(`📊 Найдено получателей: ${targetEmails.length}`);
        
        let sent = 0;
        let failed = 0;
        
        for (const email of targetEmails) {
            try {
                const { data: tokenData } = await supabase
                    .from('user_fcm_tokens')
                    .select('fcm_token')
                    .eq('user_email', email.toLowerCase())
                    .order('created_at', { ascending: false })
                    .limit(1);
                
                if (!tokenData || tokenData.length === 0) {
                    failed++;
                    continue;
                }
                
                const message = {
                    notification: { title, body },
                    data: {
                        type: 'admin_notification',
                        title: title,
                        body: body,
                        timestamp: new Date().toISOString()
                    },
                    token: tokenData[0].fcm_token,
                    android: { priority: 'high' }
                };
                
                await admin.messaging().send(message);
                sent++;
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                failed++;
                console.error(`❌ Ошибка отправки для ${email}:`, error.message);
            }
        }
        
        console.log(`✅ Массовая рассылка завершена: отправлено ${sent}, ошибок ${failed}`);
        return { sent, failed, total: targetEmails.length };
        
    } catch (error) {
        console.error('❌ Ошибка выполнения массовой рассылки:', error);
        return { sent: 0, failed: 0, total: 0, error: error.message };
    }
}

// ===== API для административной панели =====

// Получение статистики
app.get('/admin/api/stats', async (req, res) => {
    try {
        const { count: totalUsers } = await supabase
            .from('regular_users')
            .select('*', { count: 'exact', head: true });
        
        const onlineUsers = Array.from(userLastActivity.entries())
            .filter(([_, lastActivity]) => Date.now() - lastActivity < ACTIVITY_TIMEOUT)
            .length;
        
        const { count: fcmTokens } = await supabase
            .from('user_fcm_tokens')
            .select('*', { count: 'exact', head: true });
        
        res.json({
            success: true,
            totalUsers: totalUsers || 0,
            onlineUsers: onlineUsers,
            fcmTokens: fcmTokens || 0,
            activeRooms: rooms.size
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получение списка пользователей
app.get('/admin/api/users', async (req, res) => {
    try {
        const { data: users } = await supabase
            .from('regular_users')
            .select('email, first_name, last_name')
            .order('first_name');
        
        const onlineSet = new Set();
        for (const [email, lastActivity] of userLastActivity.entries()) {
            if (Date.now() - lastActivity < ACTIVITY_TIMEOUT) {
                onlineSet.add(email);
            }
        }
        
        const formattedUsers = (users || []).map(user => ({
            email: user.email,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email,
            isOnline: onlineSet.has(user.email.toLowerCase())
        }));
        
        res.json({ success: true, users: formattedUsers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Отправка массового уведомления
app.post('/admin/api/send-mass-notification', isAdmin, async (req, res) => {
    try {
        const { title, body, recipientType, recipients, scheduleTime } = req.body;
        
        if (scheduleTime) {
            const scheduledId = uuidv4();
            const scheduledTime = new Date(scheduleTime);
            
            if (scheduledTime <= new Date()) {
                return res.status(400).json({ success: false, error: 'Время отправки должно быть в будущем' });
            }
            
            scheduledNotifications.set(scheduledId, {
                id: scheduledId,
                title: title || 'Уведомление',
                body: body || '',
                recipientType,
                recipients: recipients || [],
                scheduledTime: scheduledTime.toISOString(),
                createdAt: new Date().toISOString()
            });
            
            const delay = scheduledTime.getTime() - Date.now();
            setTimeout(async () => {
                const notification = scheduledNotifications.get(scheduledId);
                if (notification) {
                    await executeMassNotification(notification);
                    scheduledNotifications.delete(scheduledId);
                }
            }, delay);
            
            res.json({ success: true, scheduled: true, scheduledId });
        } else {
            const result = await executeMassNotification({
                title: title || 'Уведомление',
                body: body || '',
                recipientType,
                recipients: recipients || []
            });
            
            res.json({ success: true, sent: result.sent, failed: result.failed, total: result.total });
        }
    } catch (error) {
        console.error('❌ Ошибка отправки:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получение запланированных уведомлений
app.get('/admin/api/scheduled', async (req, res) => {
    try {
        const notifications = Array.from(scheduledNotifications.values())
            .filter(n => new Date(n.scheduledTime) > new Date())
            .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
        
        res.json({ success: true, notifications });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Отмена запланированного уведомления
app.post('/admin/api/scheduled/cancel', isAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        
        if (!scheduledNotifications.has(id)) {
            return res.status(404).json({ success: false, error: 'Уведомление не найдено' });
        }
        
        scheduledNotifications.delete(id);
        res.json({ success: true, message: 'Уведомление отменено' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== АДМИНИСТРАТИВНАЯ ПАНЕЛЬ (HTML) =====
app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Beresta Admin Panel</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }
            .container { max-width: 900px; margin: 0 auto; }
            .header { text-align: center; color: white; margin-bottom: 30px; }
            .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
            .card {
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                margin-bottom: 20px;
                overflow: hidden;
            }
            .card-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 20px 25px;
            }
            .card-header h2 { font-size: 1.5rem; margin-bottom: 5px; }
            .card-header p { opacity: 0.9; font-size: 0.9rem; }
            .card-body { padding: 25px; }
            .form-group { margin-bottom: 20px; }
            label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
            input, select, textarea {
                width: 100%;
                padding: 12px 15px;
                border: 2px solid #e0e0e0;
                border-radius: 10px;
                font-size: 1rem;
                transition: all 0.3s;
                font-family: inherit;
            }
            input:focus, select:focus, textarea:focus {
                outline: none;
                border-color: #667eea;
                box-shadow: 0 0 0 3px rgba(102,126,234,0.1);
            }
            textarea { resize: vertical; min-height: 100px; }
            .radio-group {
                display: flex;
                gap: 20px;
                flex-wrap: wrap;
            }
            .radio-group label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: normal;
                cursor: pointer;
                margin-bottom: 0;
            }
            .radio-group input { width: auto; margin: 0; }
            button {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                padding: 14px 30px;
                border-radius: 10px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s;
                width: 100%;
            }
            button:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(102,126,234,0.4); }
            button:disabled { opacity: 0.6; transform: none; cursor: not-allowed; }
            .btn-small { width: auto; padding: 8px 15px; font-size: 0.9rem; margin-top: 10px; }
            .btn-secondary { background: #6c757d; }
            .alert {
                padding: 15px 20px;
                border-radius: 10px;
                margin-bottom: 20px;
                display: none;
            }
            .alert.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; display: block; }
            .alert.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; display: block; }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 15px;
                margin-bottom: 20px;
            }
            .stat-item {
                background: #f8f9fa;
                padding: 15px;
                border-radius: 10px;
                text-align: center;
            }
            .stat-number { font-size: 2rem; font-weight: bold; color: #667eea; }
            .stat-label { font-size: 0.85rem; color: #666; margin-top: 5px; }
            .user-list {
                max-height: 300px;
                overflow-y: auto;
                border: 1px solid #e0e0e0;
                border-radius: 10px;
                padding: 10px;
            }
            .user-item {
                display: flex;
                align-items: center;
                padding: 8px;
                border-bottom: 1px solid #f0f0f0;
            }
            .user-item:hover { background: #f8f9fa; }
            .user-item input { width: auto; margin-right: 10px; }
            .user-item label { margin-bottom: 0; flex: 1; cursor: pointer; }
            .badge {
                display: inline-block;
                padding: 4px 8px;
                border-radius: 20px;
                font-size: 0.75rem;
                font-weight: 600;
                margin-left: 10px;
            }
            .badge.online { background: #d4edda; color: #155724; }
            .badge.offline { background: #f8d7da; color: #721c24; }
            .progress {
                background: #e0e0e0;
                border-radius: 10px;
                overflow: hidden;
                margin-top: 15px;
                display: none;
            }
            .progress-bar {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                width: 0%;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 0.85rem;
                font-weight: 600;
                transition: width 0.3s;
            }
            .scheduled-list { margin-top: 15px; }
            .scheduled-item {
                background: #f8f9fa;
                padding: 10px;
                border-radius: 8px;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                flex-wrap: wrap;
                gap: 10px;
            }
            .scheduled-info { flex: 1; }
            .scheduled-title { font-weight: 600; margin-bottom: 5px; }
            .scheduled-time { font-size: 0.8rem; color: #666; }
            .scheduled-actions button {
                width: auto;
                padding: 5px 10px;
                font-size: 0.8rem;
                background: #dc3545;
            }
            .template-buttons {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }
            .template-buttons button {
                width: auto;
                background: #6c757d;
                padding: 10px 15px;
                font-size: 0.9rem;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🔔 Beresta Admin Panel</h1>
                <p>Управление массовыми уведомлениями FCM</p>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2>📊 Статистика сервера</h2>
                </div>
                <div class="card-body">
                    <div class="stats">
                        <div class="stat-item"><div class="stat-number" id="totalUsers">-</div><div class="stat-label">Всего пользователей</div></div>
                        <div class="stat-item"><div class="stat-number" id="onlineUsers">-</div><div class="stat-label">Онлайн</div></div>
                        <div class="stat-item"><div class="stat-number" id="fcmTokens">-</div><div class="stat-label">FCM токенов</div></div>
                        <div class="stat-item"><div class="stat-number" id="activeRooms">-</div><div class="stat-label">Активных комнат</div></div>
                    </div>
                    <button onclick="refreshStats()" class="btn-small btn-secondary">🔄 Обновить</button>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2>✉️ Отправить уведомление</h2>
                </div>
                <div class="card-body">
                    <div id="alert" class="alert"></div>
                    
                    <div class="form-group">
                        <label>🔐 Ваш email (администратор)</label>
                        <input type="email" id="adminEmail" placeholder="admin@beresta.ru" required>
                    </div>
                    
                    <div class="form-group">
                        <label>📝 Заголовок</label>
                        <input type="text" id="title" placeholder="Например: ⚠️ Технические работы">
                    </div>
                    
                    <div class="form-group">
                        <label>💬 Текст сообщения</label>
                        <textarea id="body" placeholder="Введите текст уведомления..."></textarea>
                    </div>
                    
                    <div class="form-group">
                        <label>👥 Получатели</label>
                        <div class="radio-group">
                            <label><input type="radio" name="recipientType" value="all" checked> Все пользователи</label>
                            <label><input type="radio" name="recipientType" value="online"> Только онлайн</label>
                            <label><input type="radio" name="recipientType" value="selected"> Выбранные</label>
                        </div>
                    </div>
                    
                    <div id="userSelectGroup" class="form-group" style="display: none;">
                        <label>👤 Выберите пользователей</label>
                        <div class="user-list" id="userList">Загрузка...</div>
                        <div style="margin-top: 10px;">
                            <button type="button" onclick="selectAllUsers()" class="btn-small btn-secondary">Выбрать всех</button>
                            <button type="button" onclick="deselectAllUsers()" class="btn-small btn-secondary">Снять всех</button>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>⏰ Отложенная отправка (опционально)</label>
                        <input type="datetime-local" id="scheduleTime">
                    </div>
                    
                    <div id="progress" class="progress">
                        <div class="progress-bar" id="progressBar">0%</div>
                    </div>
                    
                    <button id="sendBtn" onclick="sendNotification()">🚀 Отправить</button>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2>📅 Запланированные</h2>
                </div>
                <div class="card-body">
                    <div id="scheduledList">Нет запланированных</div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2>📜 Шаблоны</h2>
                </div>
                <div class="card-body">
                    <div class="template-buttons">
                        <button onclick="loadTemplate('maintenance')">🔧 Техработы</button>
                        <button onclick="loadTemplate('update')">🔄 Обновление</button>
                        <button onclick="loadTemplate('announcement')">📢 Объявление</button>
                        <button onclick="loadTemplate('maintenance_end')">✅ Работы завершены</button>
                    </div>
                </div>
            </div>
        </div>
        
        <script>
            let allUsers = [];
            
            const templates = {
                maintenance: { title: '🔧 Технические работы', body: 'Ведутся технические работы. Сервер может быть недоступен с {startTime} по {endTime}.' },
                update: { title: '🔄 Обновление сервера', body: 'Обновление запланировано на {datetime}. Сохраните важные данные.' },
                announcement: { title: '📢 Важное объявление', body: 'Уважаемые пользователи! {message}' },
                maintenance_end: { title: '✅ Работы завершены', body: 'Все сервисы работают в штатном режиме.' }
            };
            
            function showAlert(type, message) {
                const alertDiv = document.getElementById('alert');
                alertDiv.className = 'alert ' + type;
                alertDiv.innerHTML = message;
                setTimeout(() => { alertDiv.className = 'alert'; }, 5000);
            }
            
            window.loadTemplate = function(name) {
                const t = templates[name];
                if (!t) return;
                document.getElementById('title').value = t.title;
                document.getElementById('body').value = t.body;
                
                if (name === 'maintenance') {
                    const start = prompt('Время начала');
                    const end = prompt('Время окончания');
                    if (start && end) {
                        document.getElementById('body').value = t.body.replace('{startTime}', start).replace('{endTime}', end);
                    }
                } else if (name === 'update') {
                    const dt = prompt('Дата и время');
                    if (dt) document.getElementById('body').value = t.body.replace('{datetime}', dt);
                } else if (name === 'announcement') {
                    const msg = prompt('Текст объявления');
                    if (msg) document.getElementById('body').value = t.body.replace('{message}', msg);
                }
            };
            
            window.refreshStats = async function() {
                try {
                    const res = await fetch('/admin/api/stats');
                    const data = await res.json();
                    if (data.success) {
                        document.getElementById('totalUsers').textContent = data.totalUsers;
                        document.getElementById('onlineUsers').textContent = data.onlineUsers;
                        document.getElementById('fcmTokens').textContent = data.fcmTokens;
                        document.getElementById('activeRooms').textContent = data.activeRooms;
                    }
                } catch(e) { console.error(e); }
            };
            
            window.loadUsers = async function() {
                try {
                    const res = await fetch('/admin/api/users');
                    const data = await res.json();
                    if (data.success) {
                        allUsers = data.users;
                        const container = document.getElementById('userList');
                        if (allUsers.length === 0) {
                            container.innerHTML = 'Нет пользователей';
                            return;
                        }
                        container.innerHTML = allUsers.map(u => 
                            '<div class="user-item">' +
                                '<input type="checkbox" class="user-checkbox" value="' + u.email + '" id="u_' + u.email.replace(/[^a-z0-9]/gi, '_') + '">' +
                                '<label for="u_' + u.email.replace(/[^a-z0-9]/gi, '_') + '">' +
                                    '<strong>' + (u.name || u.email) + '</strong>' +
                                    '<span class="badge ' + (u.isOnline ? 'online' : 'offline') + '">' + (u.isOnline ? 'online' : 'offline') + '</span>' +
                                    '<br><small>' + u.email + '</small>' +
                                '</label>' +
                            '</div>'
                        ).join('');
                    }
                } catch(e) { console.error(e); }
            };
            
            window.selectAllUsers = function() {
                document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = true);
            };
            
            window.deselectAllUsers = function() {
                document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = false);
            };
            
            window.loadScheduled = async function() {
                const adminEmail = document.getElementById('adminEmail').value;
                if (!adminEmail) return;
                try {
                    const res = await fetch('/admin/api/scheduled?adminEmail=' + encodeURIComponent(adminEmail));
                    const data = await res.json();
                    if (data.success && data.notifications.length) {
                        const container = document.getElementById('scheduledList');
                        container.innerHTML = data.notifications.map(n => 
                            '<div class="scheduled-item">' +
                                '<div class="scheduled-info">' +
                                    '<div class="scheduled-title">' + escapeHtml(n.title) + '</div>' +
                                    '<div class="scheduled-time">📅 ' + new Date(n.scheduledTime).toLocaleString() + '</div>' +
                                    '<div><small>' + escapeHtml(n.body.substring(0, 100)) + '</small></div>' +
                                '</div>' +
                                '<div class="scheduled-actions"><button onclick="cancelScheduled(\'' + n.id + '\')">❌ Отменить</button></div>' +
                            '</div>'
                        ).join('');
                    } else {
                        document.getElementById('scheduledList').innerHTML = 'Нет запланированных';
                    }
                } catch(e) { console.error(e); }
            };
            
            window.cancelScheduled = async function(id) {
                const adminEmail = document.getElementById('adminEmail').value;
                if (!adminEmail) { showAlert('error', 'Введите email'); return; }
                if (!confirm('Отменить?')) return;
                try {
                    const res = await fetch('/admin/api/scheduled/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
                        body: JSON.stringify({ id })
                    });
                    const data = await res.json();
                    if (data.success) {
                        showAlert('success', 'Уведомление отменено');
                        loadScheduled();
                    }
                } catch(e) { showAlert('error', e.message); }
            };
            
            window.sendNotification = async function() {
                const adminEmail = document.getElementById('adminEmail').value;
                const title = document.getElementById('title').value;
                const body = document.getElementById('body').value;
                const recipientType = document.querySelector('input[name="recipientType"]:checked').value;
                const scheduleTime = document.getElementById('scheduleTime').value;
                
                if (!adminEmail) { showAlert('error', 'Введите email'); return; }
                if (!title && !body) { showAlert('error', 'Заполните заголовок или текст'); return; }
                
                let recipients = [];
                if (recipientType === 'selected') {
                    recipients = Array.from(document.querySelectorAll('.user-checkbox:checked')).map(cb => cb.value);
                    if (recipients.length === 0) { showAlert('error', 'Выберите получателей'); return; }
                }
                
                const btn = document.getElementById('sendBtn');
                const progress = document.getElementById('progress');
                const progressBar = document.getElementById('progressBar');
                
                btn.disabled = true;
                progress.style.display = 'block';
                progressBar.style.width = '50%';
                progressBar.textContent = 'Отправка...';
                
                try {
                    const res = await fetch('/admin/api/send-mass-notification', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
                        body: JSON.stringify({ title, body, recipientType, recipients, scheduleTime: scheduleTime || null })
                    });
                    const data = await res.json();
                    if (data.success) {
                        if (data.scheduled) {
                            showAlert('success', '✅ Уведомление запланировано');
                            loadScheduled();
                        } else {
                            showAlert('success', '✅ Отправлено: ' + data.sent + '/' + data.total);
                        }
                        if (!scheduleTime) {
                            document.getElementById('title').value = '';
                            document.getElementById('body').value = '';
                        }
                    } else {
                        showAlert('error', 'Ошибка: ' + data.error);
                    }
                } catch(e) {
                    showAlert('error', 'Ошибка: ' + e.message);
                } finally {
                    btn.disabled = false;
                    progress.style.display = 'none';
                    progressBar.style.width = '0%';
                }
            };
            
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
            document.querySelectorAll('input[name="recipientType"]').forEach(radio => {
                radio.addEventListener('change', function() {
                    const group = document.getElementById('userSelectGroup');
                    group.style.display = this.value === 'selected' ? 'block' : 'none';
                    if (this.value === 'selected' && allUsers.length === 0) loadUsers();
                });
            });
            
            document.getElementById('adminEmail').addEventListener('change', function() {
                if (this.value) loadScheduled();
            });
            
            refreshStats();
            setInterval(refreshStats, 30000);
        </script>
    </body>
    </html>
    `);
});

// ===== СТАТИЧЕСКИЕ ФАЙЛЫ =====
app.use('/uploads', express.static(uploadDir));

// ===== ВЕБ-ИНТЕРФЕЙС =====
app.get('/', (req, res) => {
    const onlineUsers = Array.from(userLastActivity.entries())
        .filter(([_, lastActivity]) => Date.now() - lastActivity < ACTIVITY_TIMEOUT)
        .length;
    
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
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 20px; }
            .stat-card { background: white; padding: 15px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            .stat-value { font-size: 24px; font-weight: bold; color: #333; }
            .stat-label { font-size: 14px; color: #666; }
        </style>
    </head>
    <body>
        <h1>🚀 Beresta Server</h1>
        <div class="status">
            <p><strong>Status:</strong> <span class="online">🟢 Online</span></p>
            <p><strong>Server ID:</strong> ${SERVER_ID}</p>
            <p><strong>Firebase:</strong> ${firebaseInitialized ? '✅ Активен' : '❌ Не настроен'}</p>
            <p><strong>Supabase Storage:</strong> <span class="storage">✅ Активен (bucket: ${supabaseBucketName})</span></p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${onlineUsers}</div>
                <div class="stat-label">Онлайн пользователей</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${rooms.size}</div>
                <div class="stat-label">Активных комнат</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${activeCalls.size}</div>
                <div class="stat-label">Активных звонков</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${userLastActivity.size}</div>
                <div class="stat-label">Отслеживаемых пользователей</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${callTimeouts.size}</div>
                <div class="stat-label">Активных таймаутов</div>
            </div>
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
            
            <h3>📞 Эндпоинты для звонков:</h3>
            <ul>
                <li><strong>POST /api/calls/initiate</strong> - Инициировать звонок</li>
                <li><strong>POST /api/calls/accept</strong> - Принять звонок</li>
                <li><strong>POST /api/calls/reject</strong> - Отклонить звонок</li>
                <li><strong>POST /api/calls/end</strong> - Завершить звонок</li>
                <li><strong>GET /api/calls/:roomId</strong> - Информация о звонке</li>
                <li><strong>GET /api/calls/user/:email</strong> - Звонки пользователя</li>
            </ul>
            
            <h3>👤 Эндпоинты для статусов:</h3>
            <ul>
                <li><strong>GET /api/status/:email</strong> - Статус пользователя</li>
                <li><strong>POST /api/status/batch</strong> - Статусы нескольких пользователей</li>
                <li><strong>GET /api/status/online/all</strong> - Все онлайн пользователи</li>
                <li><strong>POST /api/activity/ping</strong> - Обновить активность</li>
            </ul>
            
            <h3>🔧 Дебаг эндпоинты:</h3>
            <ul>
                <li><strong>GET /api/debug/timeouts</strong> - Информация о таймаутах</li>
                <li><strong>GET /api/debug/mappings</strong> - Маппинги socket-email</li>
                <li><strong>GET /api/debug/activity</strong> - Активность пользователей</li>
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
    console.log(`🧹 Автоочистка файлов: каждые 24 часа (файлы старше 10 дней)`);
    console.log(`👤 Отслеживание активности: включено (таймаут ${ACTIVITY_TIMEOUT/1000/60} минут)`);
    console.log(`⏱️ Таймаут звонков: 30 секунд`);
    console.log('='.repeat(60) + '\n');
    
    await ensureBucketExists();
    
    startFileCleanupScheduler();
    
    try {
        const { data: activeUsers } = await supabase
            .from('user_presence')
            .select('user_email, last_seen')
            .eq('status', 'online')
            .gte('last_seen', new Date(Date.now() - 60000).toISOString());
        
        if (activeUsers) {
            const now = Date.now();
            for (const user of activeUsers) {
                userLastActivity.set(user.user_email, now - 10000);
            }
            console.log(`👥 Восстановлена активность для ${activeUsers.length} пользователей`);
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки активных пользователей:', error);
    }
});

// ===== Graceful shutdown =====
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    
    // Очищаем все активные таймауты
    for (const [roomId, timeoutData] of callTimeouts.entries()) {
        clearTimeout(timeoutData.timeoutId);
        console.log(`⏱️ Таймаут для комнаты ${roomId} очищен при остановке`);
    }
    callTimeouts.clear();
    
    try {
        await supabase
            .from('user_presence')
            .delete()
            .eq('server_id', SERVER_ID);
        console.log('✅ Присутствие пользователей очищено');
    } catch (error) {
        console.error('❌ Ошибка очистки присутствия:', error);
    }
    
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
    
    // Очищаем все активные таймауты
    for (const [roomId, timeoutData] of callTimeouts.entries()) {
        clearTimeout(timeoutData.timeoutId);
    }
    callTimeouts.clear();
    
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
