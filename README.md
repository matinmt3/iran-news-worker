# ربات خبر ایران | Iran News Worker

نمونه‌کار یک ربات خبر تلگرام روی Cloudflare Workers و D1 با دریافت منابع، صف ارسال، کنترل تکرار، فیلترها و مسیرهای هوش مصنوعی اختیاری. این مخزن **سورس ابزار** است؛ کانال فعال، حساب کاربری، خبرهای ذخیره‌شده یا توکن سرویس همراه آن نیست.

A Persian Telegram news automation backend for Cloudflare Workers and D1: feed processing, delivery queues, destination-scoped deduplication, filters, interactive controls and optional AI adapters. This repository contains source, not an operational Telegram channel or verified live provider integration.

## بررسی محلی | Local checks

Use Node.js **22.13+ on the 22.x line, or 24+**, matching the locked ESLint/Wrangler requirements. This copy was validated with Node.js 26.4.0. The source version is `2.10.3-faithful-always-on.4`.

```sh
npm ci
cp wrangler.jsonc.example wrangler.jsonc
npm run check
npm run lint
npm test
```

در PowerShell به‌جای `cp` می‌توانید `Copy-Item wrangler.jsonc.example wrangler.jsonc` را اجرا کنید و برای مجموعه آزمون‌ها از `npm run test:windows` استفاده کنید. آزمون‌ها از شبیه‌سازهای داخل Node و پاسخ‌های کنترل‌شده استفاده می‌کنند؛ حتی فایل `test_live_selftest.mjs` در این بسته، فراخوانی زندهٔ سرویس عمومی نیست.

The shell test runner is intended for Bash/Linux. On Windows use `npm run test:windows`. Tests create controlled VM contexts and mock network/provider responses; the filename `test_live_selftest.mjs` refers to an in-process simulated self-test, not live external verification. See [VALIDATION.md](VALIDATION.md) for checks actually performed for this copy.

## اجرا و پیکربندی | Runtime configuration

این برنامه به محیط Cloudflare Workers، پایگاه D1 و برای اتصال واقعی به تنظیم حساب و secretهای شخصی نیاز دارد. شناسه‌های قالب عمداً جای‌نگهدارند. راه‌اندازی بات یا `npm run deploy` بخشی از انتشار سورس در GitHub نیست. بدون تنظیم منابع، موفقیت سرویس بیرونی ادعا نمی‌شود.

Copy the Wrangler template, create your own D1 binding and configure its identifier. Telegram/webhook/admin secrets belong in Wrangler secret storage or an ignored local `.dev.vars`; do not commit them. Optional AI providers require their own configuration. `npm run validate:deploy` checks the deployment configuration; `npm run deploy` is an explicit separate operation and was not run for this portfolio preparation.

## منشأ و محدوده | Provenance and scope

Prepared from the supplied `2.10.3-faithful-always-on.4` application source, preserving the worker and test code. Earlier `2.10.2` audit archives are a different revision and were not silently merged. Only source, tests, package metadata and sanitized configuration templates are included. Hosting backups, database exports, real channels, account identifiers, production configuration and historical raw verification logs are excluded. No new open-source license for the original application has been selected; dependency licenses remain with their respective authors.

Local tests do not establish AI/news accuracy, live Telegram delivery, production Cloudflare behavior, hosting availability or a formal security audit.
