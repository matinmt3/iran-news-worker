-- One-time, idempotent repair for diagnostics written by releases that
-- classified an AI-provider quota error as a Telegram rate limit.
UPDATE diagnostic_events
SET category = 'ai',
    code = 'AI_PROVIDER_RATE_LIMIT',
    severity = 'warning',
    diagnosis = 'یکی از سرویس‌های هوش مصنوعی به سقف موقت درخواست یا توکن رسیده است.',
    recommendation = 'ربات خودکار به کلید یا سرویس بعدی می‌رود؛ سهمیه و زمان بازنشانی همان provider را بررسی کنید.'
WHERE status = 'open'
  AND code = 'TELEGRAM_RATE_LIMIT'
  AND category = 'delivery'
  AND (
    lower(message) LIKE '%groq%'
    OR lower(message) LIKE '%gemini%'
    OR lower(message) LIKE '%cloudflare%'
    OR lower(message) LIKE '%هوش مصنوعی%'
  );
