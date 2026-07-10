# Развёртывание Greenleaf AI Bot v2 на Railway

## Что разворачивается

Этот сценарий создаёт один Railway-сервис для Node.js API и Telegram-бота, а также отдельный Railway PostgreSQL.

Telegram-админка работает в этом же сервисе. Веб-интерфейс админки при необходимости можно развернуть позже отдельным сервисом из того же монорепозитория.

## 1. Создать проект

1. Открыть Railway и нажать **New Project**.
2. Выбрать **Deploy from GitHub repo**.
3. Подключить репозиторий `posp279-blip/greenleaf-ai-bot`.
4. Для первого запуска выбрать ветку `feature/friendly-scenario-v2`.
5. Корневую директорию сервиса оставить `/`. Не указывать `artifacts/api-server`, потому что API использует общие workspace-пакеты из `lib/*`.
6. Если Railway предложит несколько сервисов монорепозитория, оставить один сервис для `@workspace/api-server`.

Файл `railway.json` автоматически задаёт:

- сборку API;
- проверку TypeScript;
- применение схемы PostgreSQL перед запуском;
- команду старта;
- healthcheck `/api/healthz`;
- перезапуск при сбое.

## 2. Добавить PostgreSQL

1. На полотне проекта нажать **+ New**.
2. Выбрать **Database → PostgreSQL**.
3. Открыть вкладку **Variables** у сервиса бота.
4. Создать `DATABASE_URL` как reference variable на `DATABASE_URL` сервиса PostgreSQL. В редакторе Railway выбрать значение через автодополнение, например `${{Postgres.DATABASE_URL}}`.

Не копировать публичную строку подключения вручную, если доступна внутренняя reference variable.

## 3. Добавить Variables и Secrets

Обязательные:

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
TELEGRAM_BOT_TOKEN=<токен BotFather>
TELEGRAM_WEBHOOK_SECRET=<случайная строка не короче 32 символов>
ADMIN_PASSWORD=<пароль админки>
SESSION_SECRET=<случайная строка не короче 64 символов>
ADMIN_TELEGRAM_IDS=<Telegram ID администраторов через запятую>
PROXY_API_KEY=<ключ Proxy API>
PROXY_API_BASE_URL=https://api.proxyapi.ru/openai/v1
PROXY_API_MODEL=gpt-4o-mini
TELEGRAM_UPDATE_DEDUP_TTL_MS=600000
TELEGRAM_USER_MIN_INTERVAL_MS=500
```

`PORT` добавлять не нужно — Railway передаёт его автоматически.

`PUBLIC_APP_URL` обычно добавлять не нужно — приложение использует `RAILWAY_PUBLIC_DOMAIN`. Он нужен только при подключении собственного домена или ручном переопределении адреса.

Токены, пароль и секреты рекомендуется пометить как **Sealed** после успешного запуска.

## 4. Создать публичный домен

1. Открыть сервис бота.
2. Перейти в **Settings → Networking**.
3. Нажать **Generate Domain**.
4. После появления домена выполнить **Redeploy**, если первый деплой уже завершился.

Приложение автоматически установит Telegram webhook:

```text
https://<RAILWAY_PUBLIC_DOMAIN>/api/bot/webhook
```

Webhook защищается значением `TELEGRAM_WEBHOOK_SECRET`.

## 5. Первый безопасный запуск

Для первой проверки использовать токен отдельного тестового Telegram-бота.

В логах должны появиться сообщения:

```text
Server listening
Bot username stored
Telegram webhook set
Telegram bot started in webhook mode
```

Проверить healthcheck:

```text
https://<RAILWAY_PUBLIC_DOMAIN>/api/healthz
```

Ожидаемый ответ:

```json
{"status":"ok"}
```

Затем пройти:

- `/start`;
- полный сценарий;
- видео и заглушки;
- финальную заявку;
- перевод заявки в партнёра;
- партнёрскую ссылку;
- кнопку «📤 Как отправить»;
- Telegram-админку;
- Proxy API.

## 6. Переключение основного Telegram-бота

Один Telegram-токен не должен одновременно использоваться рабочим Replit и Railway.

Порядок переключения:

1. Остановить старый Replit deployment.
2. В Railway заменить тестовый `TELEGRAM_BOT_TOKEN` на основной.
3. Проверить `TELEGRAM_WEBHOOK_SECRET`.
4. Выполнить Redeploy.
5. Убедиться по логам, что запущен webhook mode.
6. Отправить основному боту `/start` и проверить меню.

## 7. Обновления

Пока версия v2 не объединена с `main`, Railway должен отслеживать ветку `feature/friendly-scenario-v2`.

После слияния Pull Request №1:

1. В Railway открыть настройки Source.
2. Переключить branch на `main`.
3. Выполнить Redeploy.

Не включать несколько реплик сервиса: текущие очереди и дедупликация Telegram-сообщений хранятся в памяти одного процесса. Для этой версии должна работать одна replica.
