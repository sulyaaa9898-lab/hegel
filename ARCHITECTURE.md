# 🏗️ АРХИТЕКТУРА МИГРАЦИИ | Cyber Stack

**Дата:** 10.03.2026  
**Статус:** ✅ УТВЕРЖДЕНО к реализации  
**Версия:** 1.0

---

## 📐 РЕШЕНИЯ

| Аспект | Решение | Причина |
|--------|---------|---------|
| **БД** | SQLite | Встроенное хранилище, отличная работа с JSON, простая интеграция |
| **IDs** | Sequential AUTOINCREMENT | Простота отладки, совместимость с фронтом |
| **Удаление** | Soft delete (deleted_at) | Audit trail + восстановление данных |
| **Аудит** | Server timestamp ISO 8601 | Единое время источника истины |
| **Frontend** | Optimistic UI + sync B | Не ломаем UX, гарантируем консистентность |
| **Auth** | JWT Bearer Token | Stateless, масштабируемый, secure |
| **CORS** | Настраивается через env | Для production и тестирования |
| **Экспорт** | CSV + JSON | CSV для accountants, JSON для архива |
| **Node.js** | Express + SQLite3 + bcryptjs | Industry standard, стабильно |
| **Port** | 3000 | Стандартный порт для разработки |

---

## 🔌 BACKEND API ENDPOINTS

### 🔐 Auth (Публична)

```
POST   /api/auth/register         # Регистрация админа
POST   /api/auth/login            # Вход (return JWT + admin data)
POST   /api/auth/logout           # Выход (server-side token blacklist)
POST   /api/auth/refresh          # Обновление токена
```

### 📋 PC Bookings (Защищена - Bearer Token)

```
GET    /api/bookings/pc           # Получить все активные броні
POST   /api/bookings/pc           # Создать бронь (+ check conflict)
PUT    /api/bookings/pc/:id       # Обновить бронь
DELETE /api/bookings/pc/:id       # Soft delete бронь
GET    /api/bookings/pc/:id       # Получить одну бронь
POST   /api/bookings/pc/:id/status # Изменить статус (arrived/late/cancelled/no-show)

# Выполненные броні
GET    /api/bookings/pc/done      # Получить завершённые (filter by date range)
```

### 🎮 PS Bookings (Защищена)

```
GET    /api/bookings/ps           # Получить все брони PS
POST   /api/bookings/ps           # Создать бронь PS
PUT    /api/bookings/ps/:id       # Обновить бронь PS
DELETE /api/bookings/ps/:id       # Soft delete

GET    /api/ps/consoles           # Состояние 9 консолей
POST   /api/ps/consoles/:id/session # Запустить сеанс
PUT    /api/ps/consoles/:id/session # Обновить сеанс (add time)
POST   /api/ps/consoles/:id/session/end # Завершить сеанс
```

### 👥 Guests (Защищена)

```
GET    /api/guests/ratings        # Все рейтинги гостей
GET    /api/guests/:phone/rating  # Рейтинг конкретного гостя
```

### 👨‍💼 Admins Management (Защищена - только ROOT)

```
GET    /api/admins                # Список всех админов
DELETE /api/admins/:id            # Удалить админа (soft delete)
PUT    /api/admins/:id/password   # Изменить пароль
```

### 📊 Audit Logs (Защищена - только ROOT)

```
GET    /api/audit/logs            # Все логи (+ filters)
GET    /api/audit/logs?action=LOGIN&from=2026-03-01&to=2026-03-10
GET    /api/audit/logs?admin_id=2
POST   /api/audit/export          # Export CSV
POST   /api/audit/export/json     # Export JSON
```

---

## 🗄️ SCHEMA SQLite

```sql
-- ADMINS
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'root')),
  is_root BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

-- PC BOOKINGS
CREATE TABLE bookings_pc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  pc TEXT NOT NULL,          -- '1,2,3' or '5'
  time TEXT NOT NULL,         -- 'HH:MM'
  date_value TEXT NOT NULL,   -- 'YYYY-MM-DD'
  date_display TEXT,          -- 'DD.MM.YYYY' (cosmetic)
  phone TEXT,
  prepay TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'arrived', 'late', 'cancelled', 'no-show')),
  pc_statuses TEXT,           -- JSON: {"1": "arrived", "2": "pending"}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(admin_id) REFERENCES admins(id)
);

-- PS BOOKINGS
CREATE TABLE bookings_ps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  ps_id INTEGER NOT NULL,     -- 1-9
  name TEXT NOT NULL,
  phone TEXT,
  time TEXT NOT NULL,         -- 'HH:MM'
  date_value TEXT NOT NULL,   -- 'YYYY-MM-DD'
  status TEXT DEFAULT 'booked' CHECK(status IN ('booked', 'started', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(admin_id) REFERENCES admins(id)
);

-- PS SESSIONS (активные игровые сеансы)
CREATE TABLE ps_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ps_id INTEGER NOT NULL,
  booking_id INTEGER,         -- NULL если без брони (walk-in)
  start_time TEXT NOT NULL,
  prepaid_minutes REAL,
  total_paid INTEGER,         -- в тенге
  added_time REAL,
  selected_package TEXT,
  client_name TEXT,
  client_phone TEXT,
  is_free_time BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(booking_id) REFERENCES bookings_ps(id)
);

-- GUEST RATINGS
CREATE TABLE guest_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  rating REAL DEFAULT 100,
  total_bookings INTEGER DEFAULT 0,
  arrived INTEGER DEFAULT 0,
  late INTEGER DEFAULT 0,
  cancelled INTEGER DEFAULT 0,
  no_show INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- AUDIT LOGS (главная таблица логов)
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_login TEXT NOT NULL,        -- денормализованное для удобства
  action TEXT NOT NULL CHECK(action IN (
    'LOGIN', 'LOGOUT',
    'CREATE_BOOKING_PC', 'UPDATE_BOOKING_PC', 'DELETE_BOOKING_PC',
    'MARK_ARRIVED', 'MARK_LATE', 'MARK_CANCELLED', 'MARK_NO_SHOW',
    'CREATE_BOOKING_PS', 'UPDATE_BOOKING_PS', 'DELETE_BOOKING_PS',
    'PS_SESSION_START', 'PS_SESSION_END', 'PS_ADD_TIME',
    'CREATE_ADMIN', 'DELETE_ADMIN',
    'PASSWORD_CHANGE'
  )),
  entity TEXT CHECK(entity IN ('user', 'booking_pc', 'booking_ps', 'ps_session', 'guest_rating', 'admin')),
  entity_id INTEGER,                -- ID затронутого ресурса
  before_state TEXT,                -- JSON
  after_state TEXT,                 -- JSON
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- ISO 8601, server time
  source TEXT DEFAULT 'web' CHECK(source IN ('web', 'api', 'system')),
  ip_address TEXT,                  -- опционально для фронта
  FOREIGN KEY(admin_id) REFERENCES admins(id)
);

-- INDICES для быстрого поиска
CREATE INDEX idx_bookings_pc_date ON bookings_pc(date_value);
CREATE INDEX idx_bookings_pc_phone ON bookings_pc(phone);
CREATE INDEX idx_bookings_pc_status ON bookings_pc(status);
CREATE INDEX idx_audit_logs_admin ON audit_logs(admin_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_guest_ratings_phone ON guest_ratings(phone);
```

---

## 🔄 JWT TOKEN STRUCTURE

```json
{
  "header": {
    "alg": "HS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": 2,              // admin.id
    "login": "john_admin",
    "name": "Иван Иванов",
    "role": "admin",
    "is_root": false,
    "iat": 1678500000,     // issued at
    "exp": 1678586400      // expires (12 hours)
  },
  "signature": "..."
}
```

**Использование на фронте:**
```js
localStorage.setItem('auth_token', jwtToken);
// В каждом fetch:
headers: {
  'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
}
```

---

## 📝 AUDIT LOG ENTRY EXAMPLE

### Actionน LOGIN
```json
{
  "id": 1,
  "admin_id": 2,
  "admin_login": "john_admin",
  "action": "LOGIN",
  "entity": "user",
  "entity_id": 2,
  "before_state": null,
  "after_state": {
    "admin_id": 2,
    "login": "john_admin",
    "name": "Иван Иванов"
  },
  "timestamp": "2026-03-10T14:30:45.123Z",
  "source": "web"
}
```

### Action CREATE_BOOKING_PC
```json
{
  "id": 42,
  "admin_id": 2,
  "admin_login": "john_admin",
  "action": "CREATE_BOOKING_PC",
  "entity": "booking_pc",
  "entity_id": 15,
  "before_state": null,
  "after_state": {
    "id": 15,
    "name": "Айдар",
    "pc": "1,2",
    "time": "19:30",
    "date": "2026-03-10",
    "phone": "+7 705 123 4567",
    "prepay": "1000"
  },
  "timestamp": "2026-03-10T14:35:20.456Z",
  "source": "web"
}
```

### Action UPDATE_BOOKING_PC
```json
{
  "id": 43,
  "admin_id": 2,
  "admin_login": "john_admin",
  "action": "UPDATE_BOOKING_PC",
  "entity": "booking_pc",
  "entity_id": 15,
  "before_state": {
    "time": "19:30",
    "prepay": "1000"
  },
  "after_state": {
    "time": "20:00",
    "prepay": "1500"
  },
  "timestamp": "2026-03-10T14:36:10.789Z",
  "source": "web"
}
```

### Action DELETE_BOOKING_PC
```json
{
  "id": 44,
  "admin_id": 2,
  "admin_login": "john_admin",
  "action": "DELETE_BOOKING_PC",
  "entity": "booking_pc",
  "entity_id": 15,
  "before_state": {
    "id": 15,
    "name": "Айдар",
    "pc": "1,2",
    "status": "pending"
  },
  "after_state": null,
  "timestamp": "2026-03-10T14:37:05.234Z",
  "source": "web"
}
```

---

## ✍️ LOG EXPORT FORMATS

### CSV (для accountants)
```csv
timestamp,admin_login,action,entity,entity_id,details
2026-03-10T14:30:45.123Z,john_admin,LOGIN,user,2,Admin logged in
2026-03-10T14:35:20.456Z,john_admin,CREATE_BOOKING_PC,booking_pc,15,Created booking for Aydar PC 1,2
2026-03-10T14:36:10.789Z,john_admin,UPDATE_BOOKING_PC,booking_pc,15,Updated time and prepay
2026-03-10T14:37:05.234Z,john_admin,DELETE_BOOKING_PC,booking_pc,15,Deleted booking
```

### JSON (для архива)
```json
{
  "exported_at": "2026-03-10T15:00:00.000Z",
  "filter": {
    "from": "2026-03-01",
    "to": "2026-03-10"
  },
  "total_records": 156,
  "logs": [
    { ... full audit log entry ... }
  ]
}
```

---

## 🚀 ПЛАН МИГРАЦИИ (5 ЭТАПОВ)

### Этап 1️⃣: Backend инициализация
- [ ] `npm init` → package.json
- [ ] Установить Express, SQLite3, bcryptjs, jsonwebtoken
- [ ] Создать файловую структуру `backend/`
- [ ] Инициализировать и создать schema SQLite (в `backend/db.js`)
- [ ] Root admin обязательно

**Файлы:**
- `backend/package.json`
- `backend/db.js` (инициализация)
- `backend/server.js` (Express app)

**Тестирование:** Проверить что БД создана, root админ существует

---

### Этап 2️⃣: Auth endpoints (register/login/logout)
- [ ] `POST /api/auth/register` → hash пароля, создать админа
- [ ] `POST /api/auth/login` → verify пароля, выдать JWT
- [ ] `POST /api/auth/logout` → добавить в blacklist, логировать
- [ ] Middleware для Bearer Token валидации
- [ ] Логирование всех AUTH действий

**Файлы:**
- `backend/middleware/auth.js` (JWT middleware)
- `backend/routes/auth.js` (endpoints)

**Тестирование:** Postman / curl регистрация, вход, получение токена

---

### Этап 3️⃣: PC Bookings endpoints (миграция данных из localStorage)
- [ ] `GET /api/bookings/pc` → читать все из БД
- [ ] `POST /api/bookings/pc` → создать + check conflict + log
- [ ] `PUT /api/bookings/pc/:id` → update + log
- [ ] `DELETE /api/bookings/pc/:id` → soft delete + log
- [ ] `POST /api/bookings/pc/:id/status` → mark arrived/late/cancelled/no-show + update ratings + log
- [ ] Миграция: загрузить из localStorage текущего браузера в БД
- [ ] Удалить localStorage код (но оставить резервную копию локально)

**Файлы:**
- `backend/routes/bookings-pc.js`
- `backend/migration/migrate-from-ls.js` (одноразовый скрипт)

**Тестирование:** Все CRUD операции, логирование в audit_logs

---

### Этап 4️⃣: PS Bookings + Sessions endpoints
- [ ] `GET /api/ps/consoles` → состояние 9 консолей
- [ ] `POST /api/ps/consoles/:id/session` → запустить сеанс
- [ ] `PUT /api/ps/consoles/:id/session` → add time + log
- [ ] `POST /api/ps/consoles/:id/session/end` → завершить, log
- [ ] `GET /api/bookings/ps` + CRUD операции
- [ ] Логирование всех PS действий

**Файлы:**
- `backend/routes/bookings-ps.js`
- `backend/routes/ps-consoles.js`

**Тестирование:** Циклы игровых сеансов, занятие времени

---

### Этап 5️⃣: Guests + Audit endpoints + Frontend integration
- [ ] `GET /api/guests/ratings` → все рейтинги
- [ ] `GET /api/admins` → список (только ROOT)
- [ ] `DELETE /api/admins/:id` → удалить (только ROOT)
- [ ] `GET /api/audit/logs` → фильтры по action, date, admin
- [ ] `POST /api/audit/export` → CSV
- [ ] `POST /api/audit/export/json` → JSON
- [ ] Фронтенд: заменить все localStorage calls на fetch к backend
- [ ] Фронтенд: optimistic UI + error handling + sync retry
- [ ] CORS middleware

**Файлы:**
- `backend/routes/guests.js`
- `backend/routes/admins.js`
- `backend/routes/audit.js`
- `combo2.js` → замена всех AppStorage вызовов на API fetch

**Тестирование:** Full E2E тестирование браузером

---

## 🔐 SECURITY CHECKLIST

- [ ] Пароли хешированы (bcryptjs)
- [ ] JWT token подписан secretKey
- [ ] Bearer token валидация на каждом защищённом endpoint
- [ ] Soft delete (deleted_at не очищается)
- [ ] Audit logs immutable (никогда не удаляются)
- [ ] ROOT может всё, admin только свои действия
- [ ] Rate limiting на /auth/login (опционально)
- [ ] HTTPS в продакшене

---

## 📱 FRONTEND OPTIMISTIC UI PATTERN (Вариант B)

```js
// 1. Сохранить локально + обновить UI
bookings.push(newBooking);
renderTable();

// 2. Отправить на backend
fetch(`${process.env.APP_BASE_URL}/api/bookings/pc`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify(newBooking)
})
.then(res => res.json())
.then(data => {
  // Backend вернул ID и timestamp
  const bookingIndex = bookings.findIndex(b => b.temp_id === newBooking.temp_id);
  bookings[bookingIndex].id = data.id;
  bookings[bookingIndex].created_at = data.created_at;
  saveAll(); // sync с backend
})
.catch(err => {
  // ОТКАТ: удалить из localStorage
  const idx = bookings.findIndex(b => b.temp_id === newBooking.temp_id);
  bookings.splice(idx, 1);
  renderTable();
  showError('Failed to save booking. Reverted.');
});
```

---

## ✅ READY FOR IMPLEMENTATION

Эта архитектура готова к реализации. Следующие шаги:

1. **Этап 1** → создать backend структуру + SQLite
2. **Этап 2** → auth system  
3. **Этап 3** → PC bookings + миграция
4. **Этап 4** → PS consoles
5. **Этап 5** → Frontend полная интеграция + audit

Каждый этап будет тестирован перед переходом к следующему.

---

**Начнём?** ✅
