# Развёртывание Greenleaf AI Bot v2 на Railway

## Что разворачивается

Один Railway-сервис обслуживает Node.js API, Telegram-бота, VK-бота и веб-админку. PostgreSQL работает отдельным Railway-сервисом.

Telegram и VK используют общий сценарий, AI, реферальные коды, заявки и базу данных.

## 1. Создать проект

1. Открыть Railway и нажать **New Project**.
2. Выбрать **Deploy from GitHub repo**.
3. Подключить репозиторий `posp279-blip/greenleaf-ai-bot`.
4. Для теста VK выбрать ветку `agent/vk-channel-referrals`.
5. Корневую директорию сервиса оставить `/`.
6. Если Railway предложит несколько сервисов монорепозитория, оставить один сервис для `@workspace/api-server`.

Файл `railway.json` задаёт сборку API и админки, команду старта, healthcheck `/api/healthz` и перезапуск при сбое. При запуске приложение синхронизирует Drizzle-схему PostgreSQL до старта ботов.

## 2. Добавить PostgreSQL

1. На полотне проекта нажать **+ New**.
2. Выбрать **Database → PostgreSQL**.
3. Открыть вкладку **Variables** у сервиса бота.
4. Создать `DATABASE_URL` как reference variable на PostgreSQL, например `${{Postgres.DATABASE_URL}}`.

Не копировать публичную строку подключения вручную, если доступна внутренняя reference variable.

## 3. Добавить Variables и Secrets

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}

TELEGRAM_BOT_TOKEN=<токен BotFather>
TELEGRAM_WEBHOOK_SECRET=<случайная строка не короче 32 символов>
TELEGRAM_UPDATE_DEDUP_TTL_MS=600000
TELEGRAM_USER_MIN_INTERVAL_MS=500

VK_GROUP_TOKEN=<ключ доступа сообщества>
VK_GROUP_ID=<числовой ID сообщества без минуса>
VK_GROUP_SCREEN_NAME=<короткое имя сообщества из адреса vk.com/...>
VK_CALLBACK_SECRET=<секрет Callback API>
VK_CONFIRMATION_CODE=<строка подтверждения сервера из VK>
VK_API_VERSION=5.199
VK_EVENT_DEDUP_TTL_MS=600000
VK_USER_MIN_INTERVAL_MS=500

ADMIN_PASSWORD=<пароль админки>
SESSION_SECRET=<случайная строка не короче 64 символов>
ADMIN_TELEGRAM_IDS=<Telegram ID администраторов через запятую>

PROXY_API_KEY=<ключ Proxy API>
PROXY_API_BASE_URL=https://api.proxyapi.ru/openai/v1
PROXY_API_MODEL=gpt-4o-mini
```

`PORT` добавлять не нужно — Railway передаёт его автоматически. `PUBLIC_APP_URL` обычно не нужен: используется `RAILWAY_PUBLIC_DOMAIN`.

Токены, пароль и секреты рекомендуется пометить как **Sealed**.

## 4. Создать публичный домен

1. Открыть сервис бота.
2. Перейти в **Settings → Networking**.
3. Нажать **Generate Domain**.
4. После появления домена выполнить **Redeploy**.

Telegram webhook устанавливается автоматически:

```text
https://<RAILWAY_PUBLIC_DOMAIN>/api/bot/webhook
```

VK Callback API:

```text
https://<RAILWAY_PUBLIC_DOMAIN>/api/vk/callback
```

## 5. Настроить сообщество VK

1. Создать отдельное сообщество или использовать существующее сообщество Greenleaf.
2. Включить **Сообщения сообщества**.
3. В настройках API создать ключ доступа сообщества с минимально необходимыми правами на сообщения.
4. Скопировать токен в Railway как `VK_GROUP_TOKEN`.
5. Указать числовой ID сообщества в `VK_GROUP_ID` без знака минус.
6. В `VK_GROUP_SCREEN_NAME` указать короткое имя из адреса сообщества. Например, для `vk.com/greenleaf_agent` значение будет `greenleaf_agent`.
7. Открыть настройки **Callback API** и добавить сервер.
8. Вставить адрес `https://<RAILWAY_PUBLIC_DOMAIN>/api/vk/callback`.
9. Скопировать строку подтверждения сервера в `VK_CONFIRMATION_CODE`.
10. Создать секретную строку, указать одинаковое значение в VK и `VK_CALLBACK_SECRET`.
11. После Redeploy подтвердить сервер.
12. В событиях Callback API включить минимум **Входящее сообщение**.

## 6. Реферальные ссылки

У каждого партнёра один общий `refCode`, но две ссылки:

```text
Telegram:
https://t.me/<BOT_USERNAME>?start=<refCode>

VK:
https://vk.me/<VK_GROUP_SCREEN_NAME>?ref=<refCode>&ref_source=partner
```

Бот сохраняет первого валидного пригласившего партнёра. Повторный переход по другой ссылке не должен менять спонсора уже созданной сессии.

Кнопки **«🔗 Моя ссылка»** и **«📤 Как отправить»** показывают обе ссылки, когда `VK_GROUP_SCREEN_NAME` настроен.

## 7. Первый безопасный запуск

Для первой проверки использовать тестовое сообщество VK и, по возможности, токен отдельного тестового Telegram-бота.

Проверить healthcheck:

```text
https://<RAILWAY_PUBLIC_DOMAIN>/api/healthz
```

Затем пройти smoke-test:

### Telegram

- `/start`;
- полный сценарий;
- финальная заявка;
- партнёрская ссылка;
- кнопка «📤 Как отправить»;
- админка и уведомления.

### VK

- обычное первое сообщение сообществу;
- кнопка «▶️ Начать»;
- несколько этапов сценария и возврат через меню;
- реферальная ссылка конкретного партнёра;
- финальная заявка;
- источник `VK` в уведомлении и админке;
- отдельность сессий VK и Telegram с одинаковым числовым ID;
- повторное событие Callback API не должно создавать дубль.

### После теста

- убедиться, что рабочий Telegram-бот продолжает отвечать;
- проверить логи Railway на ошибки VK API;
- проверить вкладки **Заявки** и **Диалоги** в админке;
- не переключать production на эту ветку до завершения проверки PR.

## 8. Переключение production

Один Telegram-токен не должен одновременно использоваться двумя активными deployment.

Порядок переключения:

1. Сделать резервную копию PostgreSQL.
2. Проверить успешный CI PR с тестами, typecheck и build.
3. Остановить старый deployment только непосредственно перед переключением.
4. Установить production-переменные Railway.
5. Выполнить Redeploy.
6. Проверить Telegram и VK по smoke-test.
7. При ошибке вернуть предыдущую ветку/deployment и не менять базу вручную.

Не включать несколько реплик сервиса: очереди и дедупликация событий хранятся в памяти одного процесса. Для этой версии должна работать одна replica.
