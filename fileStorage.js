const fs = require('fs').promises;
const path = require('path');

class FileStorage {
  constructor(storagePath = './data') {
    this.storagePath = storagePath;
    this.dataFile = path.join(storagePath, 'database.json');
    this.init();
  }

  async init() {
    try {
      // Создаем папку если не существует
      await fs.mkdir(this.storagePath, { recursive: true });
      
      // Создаем файл данных если не существует
      try {
        await fs.access(this.dataFile);
      } catch {
        // Файл не существует, создаем начальную структуру
        const initialData = {
          users: [],
          friends: [],
          messages: [],
          groups: [],
          groupMembers: [],
          groupMessages: [],
          calls: [],
          agoraCalls: [],
          lastIds: {
            users: 0,
            friends: 0,
            messages: 0,
            groups: 0,
            groupMembers: 0,
            groupMessages: 0,
            calls: 0,
            agoraCalls: 0
          }
        };
        await this.saveData(initialData);
        console.log('✅ Файловое хранилище инициализировано');
      }
    } catch (error) {
      console.error('❌ Ошибка инициализации файлового хранилища:', error);
    }
  }

  async loadData() {
    try {
      const data = await fs.readFile(this.dataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('❌ Ошибка загрузки данных:', error);
      return null;
    }
  }

  async saveData(data) {
    try {
      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      console.error('❌ Ошибка сохранения данных:', error);
      return false;
    }
  }

  // Генерация ID
  generateId(data, type) {
    data.lastIds[type] = (data.lastIds[type] || 0) + 1;
    return data.lastIds[type];
  }

  // CRUD операции для пользователей
  async createUser(userData) {
    const data = await this.loadData();
    if (!data) return null;

    const user = {
      id: this.generateId(data, 'users'),
      ...userData,
      created_at: new Date().toISOString()
    };

    data.users.push(user);
    await this.saveData(data);
    return user;
  }

  async getUserByEmail(email) {
    const data = await this.loadData();
    if (!data) return null;
    return data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  }

  async getAllUsers() {
    const data = await this.loadData();
    if (!data) return [];
    return data.users;
  }

  // CRUD для друзей
  async addFriend(userEmail, friendEmail) {
    const data = await this.loadData();
    if (!data) return null;

    const existing = data.friends.find(f => 
      f.user_email === userEmail.toLowerCase() && 
      f.friend_email === friendEmail.toLowerCase()
    );

    if (existing) return existing;

    const friend = {
      id: this.generateId(data, 'friends'),
      user_email: userEmail.toLowerCase(),
      friend_email: friendEmail.toLowerCase(),
      created_at: new Date().toISOString()
    };

    data.friends.push(friend);
    await this.saveData(data);
    return friend;
  }

  async getUserFriends(userEmail) {
    const data = await this.loadData();
    if (!data) return [];
    return data.friends.filter(f => f.user_email === userEmail.toLowerCase());
  }

  async removeFriend(userEmail, friendEmail) {
    const data = await this.loadData();
    if (!data) return false;

    const index = data.friends.findIndex(f => 
      f.user_email === userEmail.toLowerCase() && 
      f.friend_email === friendEmail.toLowerCase()
    );

    if (index !== -1) {
      data.friends.splice(index, 1);
      await this.saveData(data);
      return true;
    }
    return false;
  }

  // CRUD для сообщений
  async createMessage(messageData) {
    const data = await this.loadData();
    if (!data) return null;

    const message = {
      id: this.generateId(data, 'messages'),
      ...messageData,
      sender_email: messageData.sender_email.toLowerCase(),
      receiver_email: messageData.receiver_email.toLowerCase(),
      timestamp: new Date().toISOString(),
      status: messageData.status || 'sent'
    };

    data.messages.push(message);
    await this.saveData(data);
    return message;
  }

  async getMessagesBetweenUsers(user1, user2) {
    const data = await this.loadData();
    if (!data) return [];
    
    return data.messages.filter(m => 
      (m.sender_email === user1.toLowerCase() && m.receiver_email === user2.toLowerCase()) ||
      (m.sender_email === user2.toLowerCase() && m.receiver_email === user1.toLowerCase())
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  // CRUD для групп
  async createGroup(groupData) {
    const data = await this.loadData();
    if (!data) return null;

    const group = {
      id: this.generateId(data, 'groups'),
      ...groupData,
      created_by: groupData.created_by.toLowerCase(),
      created_at: new Date().toISOString()
    };

    data.groups.push(group);
    await this.saveData(data);
    return group;
  }

  async getUserGroups(userEmail) {
    const data = await this.loadData();
    if (!data) return [];
    
    const userGroups = data.groupMembers
      .filter(m => m.user_email === userEmail.toLowerCase())
      .map(m => data.groups.find(g => g.id === m.group_id))
      .filter(g => g);

    return userGroups;
  }

  // Автоматическое добавление в чаты
  async addToChatsAutomatically(user1, user2) {
    await this.addFriend(user1, user2);
    await this.addFriend(user2, user1);
  }

  // Резервное копирование
  async createBackup() {
    const data = await this.loadData();
    if (!data) return false;

    const backupFile = path.join(this.storagePath, `backup-${Date.now()}.json`);
    await fs.writeFile(backupFile, JSON.stringify(data, null, 2));
    console.log('✅ Резервная копия создана:', backupFile);
    return true;
  }

  // Статистика
  async getStats() {
    const data = await this.loadData();
    if (!data) return null;

    return {
      users: data.users.length,
      friends: data.friends.length,
      messages: data.messages.length,
      groups: data.groups.length,
      lastBackup: null // Можно добавить информацию о бэкапах
    };
  }
}

// Создаем экземпляр хранилища
const storage = new FileStorage();

module.exports = storage;
