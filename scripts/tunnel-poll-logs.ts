// Phase 8: tail CloudWatch Logs for a tunnel-mode pod and extract the
// device-code authentication URL + code, which `code tunnel` prints to stdout
// on first launch (per upstream setup guide §10).
//
// Surfaces the URL/code as a GitHub Actions ::notice:: line and writes it to
// $GITHUB_STEP_SUMMARY so the user can complete authentication.

export {};
