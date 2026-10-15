#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --check worker.js
node tests/test_worker.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_full_suite.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_hardening.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_ad_cleanup_media_caption.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_regressions_271.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_stress_properties.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_gemini_pool.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_v290_multiai_topics_media.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_v210_filters_api.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_gemini_auth_keys.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_codex_regressions.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_audit_regressions.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_workers_ai_binding.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_button_callback_coverage.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_button_flows.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_keyboard_contracts.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_state_flows.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_live_selftest.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_user_reported_news_media_regressions.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_faithful_translation_single_message_always_on.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_cloudflare_best_practices.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_destination_scoped_dedupe.mjs

NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_ai_health_progress_dedup.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_smart_diagnostics.mjs
NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_queue_flow_control.mjs

NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_owner_faulty_sources.mjs

NODE_OPTIONS='--unhandled-rejections=strict' node tests/test_subrequest_budget.mjs
