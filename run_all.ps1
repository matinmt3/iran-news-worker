$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

node --check worker.js
$env:NODE_OPTIONS = '--unhandled-rejections=strict'
$tests = @(
  'tests/test_worker.mjs',
  'tests/test_full_suite.mjs',
  'tests/test_hardening.mjs',
  'tests/test_ad_cleanup_media_caption.mjs',
  'tests/test_regressions_271.mjs',
  'tests/test_stress_properties.mjs',
  'tests/test_gemini_pool.mjs',
  'tests/test_v290_multiai_topics_media.mjs',
  'tests/test_v210_filters_api.mjs',
  'tests/test_gemini_auth_keys.mjs',
  'tests/test_codex_regressions.mjs',
  'tests/test_audit_regressions.mjs',
  'tests/test_workers_ai_binding.mjs',
  'tests/test_button_callback_coverage.mjs',
  'tests/test_button_flows.mjs',
  'tests/test_keyboard_contracts.mjs',
  'tests/test_state_flows.mjs',
  'tests/test_live_selftest.mjs',
  'tests/test_user_reported_news_media_regressions.mjs',
  'tests/test_faithful_translation_single_message_always_on.mjs',
  'tests/test_cloudflare_best_practices.mjs',
  'tests/test_destination_scoped_dedupe.mjs',
  'tests/test_ai_health_progress_dedup.mjs',
  'tests/test_smart_diagnostics.mjs',
  'tests/test_queue_flow_control.mjs',
  'tests/test_owner_faulty_sources.mjs',
  'tests/test_subrequest_budget.mjs'
)
foreach ($testFile in $tests) {
  Write-Host "=== $testFile ==="
  node $testFile
  if ($LASTEXITCODE -ne 0) { throw "Test failed: $testFile" }
}
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Write-Host 'ALL TEST FILES PASSED'
