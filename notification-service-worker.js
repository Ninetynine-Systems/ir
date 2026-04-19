const NOTIFICATION_SCHEDULE = [
  {
    timeOfDay: "morning",
    hour: 7,
    minute: 30,
    title: "Morning Reflection",
    body: "Start your day with a peaceful reflection ☀️",
  },
  {
    timeOfDay: "noon",
    hour: 13,
    minute: 0,
    title: "Midday Pause",
    body: "Take a moment to reconnect 📿",
  },
  {
    timeOfDay: "evening",
    hour: 18,
    minute: 0,
    title: "Evening Reflection",
    body: "Unwind with an evening remembrance 🌅",
  },
  {
    timeOfDay: "night",
    hour: 21,
    minute: 0,
    title: "Night Reflection",
    body: "Close your day with peace and gratitude 🌙",
  },
];

const MESSAGE_TYPES = {
  showNotification: "SHOW_NOTIFICATION",
  checkNow: "CHECK_NOW",
  clearState: "CLEAR_STATE",
  updateConfig: "UPDATE_CONFIG",
};

const SW_NOTIFICATION_STATE_KEY_PREFIX = "ir-sw-shown-";
const PERIODIC_SYNC_TAG = "ir-notification-check";
const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_ICON_PATH = "/favicon.ico";
const DEFAULT_CONTENT_BASE_URL = "";
const STRIP_MARKDOWN_MAX_LENGTH = 200;
const CONFIG_CACHE_NAME = "ir-notification-config";
const CONFIG_CACHE_URL = "/__notification_config__";
const SHOWN_CACHE_NAME = "ir-web-notification-shown";

const shownInSession = new Set();
const workerConfig = {
  enabled: false,
  locale: "en",
  fallbackLocales: [],
  contentBaseUrl: DEFAULT_CONTENT_BASE_URL,
  windowMinutes: DEFAULT_WINDOW_MINUTES,
  iconPath: DEFAULT_ICON_PATH,
};

let configLoadPromise = null;

function mergeWorkerConfig(partial) {
  if (typeof partial.enabled === "boolean") {
    workerConfig.enabled = partial.enabled;
  }
  if (typeof partial.locale === "string") {
    workerConfig.locale = partial.locale;
  }
  if (Array.isArray(partial.fallbackLocales)) {
    workerConfig.fallbackLocales = partial.fallbackLocales.filter((value) => typeof value === "string");
  }
  if (typeof partial.contentBaseUrl === "string") {
    workerConfig.contentBaseUrl = partial.contentBaseUrl.replace(/\/$/, "");
  }
  if (typeof partial.windowMinutes === "number") {
    workerConfig.windowMinutes = partial.windowMinutes;
  }
  if (typeof partial.iconPath === "string") {
    workerConfig.iconPath = partial.iconPath;
  }
}

async function loadPersistedWorkerConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE_NAME);
    const response = await cache.match(CONFIG_CACHE_URL);
    if (!response) {
      return;
    }

    const storedConfig = await response.json();
    mergeWorkerConfig(storedConfig || {});
  } catch {
    // Best-effort only.
  }
}

async function persistWorkerConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE_NAME);
    await cache.put(
      CONFIG_CACHE_URL,
      new Response(JSON.stringify(workerConfig), {
        headers: {
          "content-type": "application/json",
        },
      }),
    );
  } catch {
    // Best-effort only.
  }
}

function ensureWorkerConfigLoaded() {
  if (!configLoadPromise) {
    configLoadPromise = loadPersistedWorkerConfig();
  }

  return configLoadPromise;
}

function formatLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinWindow(config, now = new Date()) {
  const scheduledMinutes = config.hour * 60 + config.minute;
  const nowMinutes = getMinutes(now);
  const delta = nowMinutes - scheduledMinutes;

  return delta >= 0 && delta <= workerConfig.windowMinutes;
}

function stateKey(config, date = formatLocalDateKey()) {
  return `${SW_NOTIFICATION_STATE_KEY_PREFIX}${date}-${config.timeOfDay}`;
}

function getShownStateCacheKey(configOrTimeOfDay, date = formatLocalDateKey()) {
  const config = typeof configOrTimeOfDay === "string"
    ? findScheduleConfig(configOrTimeOfDay)
    : configOrTimeOfDay;

  if (!config) {
    return null;
  }

  return `/__notification_shown__/${date}/${config.timeOfDay}`;
}

function findScheduleConfig(timeOfDay) {
  return NOTIFICATION_SCHEDULE.find((config) => config.timeOfDay === timeOfDay) || null;
}

async function persistShownState(configOrTimeOfDay, date) {
  const config = typeof configOrTimeOfDay === "string"
    ? findScheduleConfig(configOrTimeOfDay)
    : configOrTimeOfDay;

  if (!config) return;

  shownInSession.add(stateKey(config, date));

  try {
    const cache = await caches.open(SHOWN_CACHE_NAME);
    const cacheKey = getShownStateCacheKey(config, date);
    if (cacheKey) {
      await cache.put(cacheKey, new Response("1"));
    }
  } catch {
    // Best-effort only.
  }
}

async function hasPersistedShownState(config, date) {
  try {
    const cache = await caches.open(SHOWN_CACHE_NAME);
    const cacheKey = getShownStateCacheKey(config, date);
    if (!cacheKey) {
      return false;
    }

    const match = await cache.match(cacheKey);
    return match !== undefined;
  } catch {
    return false;
  }
}

function wasShown(config, date) {
  return shownInSession.has(stateKey(config, date));
}

async function wasShownAsync(config, date) {
  return wasShown(config, date) || await hasPersistedShownState(config, date);
}

function stripMarkdown(text, maxLength = STRIP_MARKDOWN_MAX_LENGTH) {
  const stripped = String(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_~`>]/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength - 3)}...`;
}

function buildNotificationUrl(date, timeOfDay) {
  if (date === formatLocalDateKey()) {
    return `/?notification=1&time=${timeOfDay}`;
  }

  return `/reflection/${date}?notification=1&time=${timeOfDay}`;
}

function resolveClickTarget(data = {}) {
  const date = typeof data.date === "string" ? data.date : formatLocalDateKey();
  const timeOfDay = typeof data.timeOfDay === "string" ? data.timeOfDay : null;

  if (timeOfDay && findScheduleConfig(timeOfDay)) {
    return buildNotificationUrl(date, timeOfDay);
  }

  if (typeof data.url === "string") {
    return data.url;
  }

  return "/";
}

function getLocalesToTry() {
  return Array.from(
    new Set([workerConfig.locale, ...(workerConfig.fallbackLocales || [])].filter(Boolean)),
  );
}

async function fetchNotificationBody(config, date) {
  if (!workerConfig.contentBaseUrl) {
    return config.body;
  }

  for (const locale of getLocalesToTry()) {
    try {
      const manifestResponse = await fetch(
        `${workerConfig.contentBaseUrl}/${locale}/daily/${date}/manifest.json`,
        { cache: "no-store" },
      );
      if (!manifestResponse.ok) {
        continue;
      }

      const manifest = await manifestResponse.json();
      const file = (manifest.files || []).find((entry) => entry.time_of_day === config.timeOfDay);
      if (!file) {
        continue;
      }

      const markdownResponse = await fetch(
        `${workerConfig.contentBaseUrl}/${locale}/daily/${date}/${file.name}`,
        { cache: "no-store" },
      );
      if (!markdownResponse.ok) {
        continue;
      }

      const markdown = await markdownResponse.text();
      const body = stripMarkdown(markdown);
      if (body) {
        return body;
      }
    } catch {
      // Fall back to default body below.
    }
  }

  return config.body;
}

function buildPayload(config, date, body) {
  return {
    body,
    tag: `ir-${date}-${config.timeOfDay}`,
    data: {
      type: "daily-reflection",
      timeOfDay: config.timeOfDay,
      date,
      url: buildNotificationUrl(date, config.timeOfDay),
    },
    icon: workerConfig.iconPath || DEFAULT_ICON_PATH,
    badge: workerConfig.iconPath || DEFAULT_ICON_PATH,
  };
}

async function showScheduledNotification(config, date) {
  if (!workerConfig.enabled || await wasShownAsync(config, date)) {
    return;
  }

  await persistShownState(config, date);
  const body = await fetchNotificationBody(config, date);
  await self.registration.showNotification(config.title, buildPayload(config, date, body));
}

async function checkAndNotify(now = new Date()) {
  await ensureWorkerConfigLoaded();

  if (!workerConfig.enabled) {
    return;
  }

  const date = formatLocalDateKey(now);
  const tasks = [];

  for (const config of NOTIFICATION_SCHEDULE) {
    if (!isWithinWindow(config, now) || wasShown(config, date)) {
      continue;
    }

    tasks.push(showScheduledNotification(config, date));
  }

  await Promise.all(tasks);
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await ensureWorkerConfigLoaded();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data || {};

  switch (message.type) {
    case MESSAGE_TYPES.showNotification: {
      event.waitUntil((async () => {
        await ensureWorkerConfigLoaded();
        const data = message.data || {};
        const date = typeof data.date === "string" ? data.date : formatLocalDateKey();
        if (typeof data.timeOfDay === "string") {
          await persistShownState(data.timeOfDay, date);
        }

        await self.registration.showNotification(
          message.title,
          {
            body: message.body,
            tag: message.tag,
            icon: workerConfig.iconPath || DEFAULT_ICON_PATH,
            badge: workerConfig.iconPath || DEFAULT_ICON_PATH,
            data,
          },
        );
      })());
      break;
    }
    case MESSAGE_TYPES.checkNow: {
      event.waitUntil(checkAndNotify());
      break;
    }
    case MESSAGE_TYPES.clearState: {
      shownInSession.clear();
      break;
    }
    case MESSAGE_TYPES.updateConfig: {
      mergeWorkerConfig(message);
      event.waitUntil(persistWorkerConfig());
      break;
    }
    default:
      break;
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(checkAndNotify());
});

self.addEventListener("sync", (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(checkAndNotify());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = resolveClickTarget(event.notification.data || {});
  const target = new URL(targetUrl, self.registration.scope).href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const matchingClient = clients.find((client) => client.url.startsWith(self.registration.scope));

    if (matchingClient) {
      if (typeof matchingClient.navigate === "function") {
        await matchingClient.navigate(target).catch(() => {});
      }
      if (typeof matchingClient.focus === "function") {
        await matchingClient.focus();
      }
      return;
    }

    await self.clients.openWindow(target);
  })());
});
