const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const isRender = process.env.NODE_ENV === 'production';

// Хранилище для WebRTC соединений
const activeUsers = new Map(); // email -> socketId
const activeCalls = new Map(); // callId -> call info
const pendingCalls = new Map(); // receiverEmail -> call info
const peerConnections = new Map(); // socketId -> room/channel

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
  maxHttpBufferSize: 1e8,
  connectTimeout: 45000
});

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
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
    }
});

// Функция само-пинга для Render.com
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
        }, 4 * 60 * 1000);

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

// Функции для работы с Supabase

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

        await supabase
            .from('friends')
            .upsert({ 
                user_email: user1.toLowerCase(), 
                friend_email: user2.toLowerCase() 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

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

// === WEBRTC SIGNALING HANDLERS ===

io.on('connection', (socket) => {
  console.log('✅ WebSocket подключение установлено:', socket.id);
  
  let userEmail = null;

  // Аутентификация пользователя
  socket.on('authenticate', (data) => {
    if (data && data.email) {
      userEmail = data.email.toLowerCase();
      
      // Удаляем предыдущее соединение если было
      if (activeUsers.has(userEmail)) {
        const oldSocketId = activeUsers.get(userEmail);
        if (oldSocketId !== socket.id) {
          io.to(oldSocketId).emit('force_disconnect', { reason: 'NEW_CONNECTION' });
        }
      }
      
      activeUsers.set(userEmail, socket.id);
      socket.userEmail = userEmail;
      
      console.log(`👤 Пользователь аутентифицирован: ${userEmail} (socket: ${socket.id})`);
      console.log(`📊 Всего онлайн: ${activeUsers.size} пользователей`);

      socket.emit('authenticated', {
        status: 'success',
        email: userEmail,
        timestamp: new Date().toISOString()
      });

      // Уведомляем других о статусе онлайн
      socket.broadcast.emit('user_status_changed', {
        email: userEmail,
        status: 'online',
        timestamp: new Date().toISOString()
      });
    }
  });

  // === ЗВОНКИ (SIGNALING) ===

  // Инициация звонка
  socket.on('call:initiate', (data) => {
    try {
      const { receiverEmail, callType } = data;
      
      if (!receiverEmail || !callType) {
        socket.emit('call:error', { error: 'Missing required fields' });
        return;
      }

      if (!userEmail) {
        socket.emit('call:error', { error: 'Not authenticated' });
        return;
      }

      const receiverSocketId = activeUsers.get(receiverEmail.toLowerCase());
      
      if (!receiverSocketId) {
        socket.emit('call:error', { error: 'USER_OFFLINE', receiver: receiverEmail });
        return;
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const callInfo = {
        callId,
        callerEmail: userEmail,
        receiverEmail: receiverEmail.toLowerCase(),
        callType,
        status: 'ringing',
        startTime: Date.now(),
        callerSocketId: socket.id,
        receiverSocketId
      };

      activeCalls.set(callId, callInfo);
      pendingCalls.set(receiverEmail.toLowerCase(), callInfo);

      // Уведомляем получателя о входящем звонке
      io.to(receiverSocketId).emit('call:incoming', {
        callId,
        callerEmail: userEmail,
        callType,
        timestamp: Date.now()
      });

      console.log(`📞 Инициирован звонок: ${callId} (${userEmail} -> ${receiverEmail})`);

      socket.emit('call:initiated', {
        success: true,
        callId,
        message: 'Звонок инициирован'
      });

      // Автоматически удаляем через 60 секунд если не ответили
      setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && call.status === 'ringing') {
          endCall(callId, 'timeout');
        }
      }, 60000);

    } catch (error) {
      console.error('❌ Ошибка инициации звонка:', error);
      socket.emit('call:error', { error: 'Internal error' });
    }
  });

  // Принятие звонка
  socket.on('call:accept', (data) => {
    try {
      const { callId } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call:error', { error: 'CALL_NOT_FOUND' });
        return;
      }

      if (call.status !== 'ringing') {
        socket.emit('call:error', { error: 'INVALID_CALL_STATUS' });
        return;
      }

      call.status = 'accepted';
      activeCalls.set(callId, call);
      
      // Удаляем из ожидающих
      pendingCalls.delete(call.receiverEmail);

      // Уведомляем инициатора
      io.to(call.callerSocketId).emit('call:accepted', {
        callId,
        receiverEmail: call.receiverEmail,
        timestamp: Date.now()
      });

      // Уведомляем получателя
      socket.emit('call:accepted_confirmation', {
        callId,
        success: true
      });

      console.log(`✅ Звонок принят: ${callId}`);

    } catch (error) {
      console.error('❌ Ошибка принятия звонка:', error);
      socket.emit('call:error', { error: 'Internal error' });
    }
  });

  // Отклонение звонка
  socket.on('call:reject', (data) => {
    try {
      const { callId } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        return;
      }

      call.status = 'rejected';
      
      // Уведомляем инициатора
      io.to(call.callerSocketId).emit('call:rejected', {
        callId,
        receiverEmail: call.receiverEmail,
        timestamp: Date.now()
      });

      // Очищаем
      activeCalls.delete(callId);
      pendingCalls.delete(call.receiverEmail);

      console.log(`❌ Звонок отклонен: ${callId}`);

    } catch (error) {
      console.error('❌ Ошибка отклонения звонка:', error);
    }
  });

  // Завершение звонка
  socket.on('call:end', (data) => {
    try {
      const { callId } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        return;
      }

      endCall(callId, 'ended');

    } catch (error) {
      console.error('❌ Ошибка завершения звонка:', error);
    }
  });

  // WebRTC signaling: предложение SDP
  socket.on('call:offer', (data) => {
    try {
      const { callId, offer, to } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call:error', { error: 'CALL_NOT_FOUND' });
        return;
      }

      const targetSocketId = to === 'caller' ? call.callerSocketId : call.receiverSocketId;
      
      io.to(targetSocketId).emit('call:offer', {
        callId,
        offer,
        from: userEmail,
        fromSocket: socket.id
      });

    } catch (error) {
      console.error('❌ Ошибка отправки offer:', error);
    }
  });

  // WebRTC signaling: ответ SDP
  socket.on('call:answer', (data) => {
    try {
      const { callId, answer, to } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call:error', { error: 'CALL_NOT_FOUND' });
        return;
      }

      const targetSocketId = to === 'caller' ? call.callerSocketId : call.receiverSocketId;
      
      io.to(targetSocketId).emit('call:answer', {
        callId,
        answer,
        from: userEmail,
        fromSocket: socket.id
      });

    } catch (error) {
      console.error('❌ Ошибка отправки answer:', error);
    }
  });

  // WebRTC signaling: ICE кандидаты
  socket.on('call:ice-candidate', (data) => {
    try {
      const { callId, candidate, to } = data;
      
      const call = activeCalls.get(callId);
      
      if (!call) {
        return;
      }

      const targetSocketId = to === 'caller' ? call.callerSocketId : call.receiverSocketId;
      
      io.to(targetSocketId).emit('call:ice-candidate', {
        callId,
        candidate,
        from: userEmail,
        fromSocket: socket.id
      });

    } catch (error) {
      console.error('❌ Ошибка отправки ICE кандидата:', error);
    }
  });

  // Проверка статуса звонка
  socket.on('call:check-status', (data) => {
    try {
      const { callId } = data;
      
      const call = activeCalls.get(callId);
      
      socket.emit('call:status', {
        callId,
        status: call ? call.status : 'not_found',
        exists: !!call
      });

    } catch (error) {
      console.error('❌ Ошибка проверки статуса:', error);
    }
  });

  // Отключение
  socket.on('disconnect', (reason) => {
    console.log(`❌ WebSocket отключен: ${socket.id}, причина: ${reason}`);
    
    if (userEmail) {
      activeUsers.delete(userEmail);
      console.log(`👤 Удален из онлайн: ${userEmail}`);
      
      // Завершаем все активные звонки пользователя
      activeCalls.forEach((call, callId) => {
        if (call.callerEmail === userEmail || call.receiverEmail === userEmail) {
          endCall(callId, 'disconnected');
        }
      });
      
      socket.broadcast.emit('user_status_changed', {
        email: userEmail,
        status: 'offline',
        timestamp: new Date().toISOString(),
        reason: reason
      });
    }
    
    console.log(`📊 Осталось онлайн: ${activeUsers.size} пользователей`);
  });

  // Обработка ошибок
  socket.on('error', (error) => {
    console.error('💥 WebSocket ошибка:', error);
  });

  // Ping для поддержания соединения
  socket.on('ping', (data) => {
    socket.emit('pong', {
      ...data,
      serverTime: new Date().toISOString()
    });
  });

});

// Вспомогательная функция для завершения звонка
function endCall(callId, reason) {
  const call = activeCalls.get(callId);
  
  if (!call) {
    return;
  }

  call.status = reason;

  // Уведомляем участников
  if (call.callerSocketId) {
    io.to(call.callerSocketId).emit('call:ended', { callId, reason });
  }
  
  if (call.receiverSocketId) {
    io.to(call.receiverSocketId).emit('call:ended', { callId, reason });
  }

  // Очищаем
  activeCalls.delete(callId);
  pendingCalls.delete(call.receiverEmail);

  console.log(`📞 Звонок завершен: ${callId}, причина: ${reason}`);
}

// === HTTP ENDPOINTS ===

// Health check
app.get('/health', async (req, res) => {
    try {
        const { error } = await supabase.from('regular_users').select('count', { count: 'exact', head: true });
        
        if (error) throw error;
        
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

// Проверка статуса звонка (HTTP fallback)
app.get('/call/status/:callId', (req, res) => {
    try {
        const { callId } = req.params;
        
        const call = activeCalls.get(callId);
        
        res.json({
            success: true,
            status: call ? call.status : 'not_found',
            call: call ? {
                callId: call.callId,
                callerEmail: call.callerEmail,
                receiverEmail: call.receiverEmail,
                callType: call.callType,
                status: call.status,
                startTime: call.startTime
            } : null
        });
    } catch (error) {
        console.error('❌ Ошибка проверки статуса звонка:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Проверка активных звонков для пользователя
app.get('/call/active/:userEmail', (req, res) => {
    try {
        const userEmail = req.params.userEmail.toLowerCase();
        
        const userCalls = [];
        activeCalls.forEach((call, callId) => {
            if (call.callerEmail === userEmail || call.receiverEmail === userEmail) {
                userCalls.push({
                    callId,
                    callerEmail: call.callerEmail,
                    receiverEmail: call.receiverEmail,
                    callType: call.callType,
                    status: call.status,
                    startTime: call.startTime
                });
            }
        });
        
        res.json({
            success: true,
            calls: userCalls,
            count: userCalls.length
        });
    } catch (error) {
        console.error('❌ Ошибка проверки активных звонков:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
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

        const { error: error1 } = await supabase
            .from('friends')
            .upsert({ 
                user_email: normalizedUserEmail, 
                friend_email: normalizedFriendEmail 
            }, { 
                onConflict: 'user_email,friend_email',
                ignoreDuplicates: true 
            });

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

        const { data: friends, error } = await supabase
            .from('friends')
            .select(`
                friend_email,
                regular_users!friends_friend_email_fkey (first_name, last_name),
                beresta_users!friends_friend_email_fkey (first_name, last_name)
            `)
            .eq('user_email', userEmail);

        if (error) throw error;

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

        chats.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

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

        const completeFileUpload = async () => {
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
                        attachment_size: req.file.size
                    }])
                    .select();

                if (error) throw error;

                if (moveFileToPermanent(req.file.filename)) {
                    res.json({
                        success: true,
                        messageId: data[0].id,
                        filename: req.file.filename
                    });

                    addToChatsAutomatically(senderEmail, receiverEmail);
                } else {
                    throw new Error('Ошибка перемещения файла');
                }
            } catch (error) {
                fs.unlinkSync(req.file.path);
                throw error;
            }
        };

        await completeFileUpload();

    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
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

// Получение информации о файле
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

        const { error: memberError1 } = await supabase
            .from('group_members')
            .insert([{
                group_id: group.id,
                user_email: createdBy.toLowerCase(),
                role: 'admin'
            }]);

        if (memberError1) throw memberError1;

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

// Получение групп пользователя
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
        const { groupId, senderEmail, message } = req.body;

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
                message: message || ''
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

        const completeFileUpload = async () => {
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
                        attachment_size: req.file.size
                    }])
                    .select();

                if (error) throw error;

                if (moveFileToPermanent(req.file.filename)) {
                    res.json({
                        success: true,
                        messageId: data[0].id,
                        filename: req.file.filename
                    });
                } else {
                    throw new Error('Ошибка перемещения файла');
                }
            } catch (error) {
                fs.unlinkSync(req.file.path);
                throw error;
            }
        };

        await completeFileUpload();

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
            message: 'История чата очищена'
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
            message: 'Аккаунт удален'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления аккаунта:', error);
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
    console.log(`💾 База данных: Supabase (${supabaseUrl})`);
    
    if (isRender) {
        startSelfPing();
        console.log('✅ Внутренний само-пинг активирован');
    }
    
    console.log('✅ Сервер готов к работе');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});
