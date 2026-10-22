// Package quota reads each subscription's remaining usage from the provider's
// own usage endpoint. Requests go through the proxy's management api-call, so
// tokens are refreshed and never leave the embedded proxy.
package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/esokullu/webbrain-systray/internal/core"
)

// Row is one usage window, e.g. the 5-hour or weekly limit.
type Row struct {
	// Window is "5h", "day", "week", "month" or "custom"; Scope narrows it
	// (a model family or feature). Label is an English fallback.
	Window    string     `json:"window"`
	Scope     string     `json:"scope,omitempty"`
	Label     string     `json:"label"`
	Remaining *float64   `json:"remaining"` // percent left, 0..100
	ResetAt   *time.Time `json:"reset_at,omitempty"`
	Detail    string     `json:"detail,omitempty"`
}

type State struct {
	Status    string    `json:"status"` // ok | error | unsupported | loading
	Rows      []Row     `json:"rows"`
	Plan      string    `json:"plan,omitempty"`
	Error     string    `json:"error,omitempty"`
	FetchedAt time.Time `json:"fetched_at"`
}

// Supported reports whether a usage endpoint is known for the provider.
func Supported(provider string) bool {
	switch provider {
	case "claude", "anthropic", "codex", "antigravity", "kimi", "kimi-ai", "xai", "grok":
		return true
	}
	return false
}

// Fetch reads the current usage of one credential.
func Fetch(ctx context.Context, m *core.Mgmt, c core.Credential) State {
	if c.Bool("disabled") {
		return State{Status: "error", Error: "disabled", FetchedAt: time.Now()}
	}
	idx := c.AuthIndex()
	if idx == "" {
		return State{Status: "error", Error: "credential has no auth index", FetchedAt: time.Now()}
	}
	var (
		st  State
		err error
	)
	switch c.Provider() {
	case "claude", "anthropic":
		st, err = claude(ctx, m, idx)
	case "codex":
		st, err = codex(ctx, m, c)
	case "antigravity":
		st, err = antigravity(ctx, m, c)
	case "kimi", "kimi-ai":
		st, err = kimi(ctx, m, c)
	case "xai", "grok":
		st, err = xai(ctx, m, c)
	default:
		return State{Status: "unsupported", FetchedAt: time.Now()}
	}
	st.FetchedAt = time.Now()
	if err != nil {
		st.Status = "error"
		st.Error = err.Error()
		return st
	}
	if len(st.Rows) == 0 {
		st.Status = "error"
		st.Error = "usage response not recognised"
		return st
	}
	st.Status = "ok"
	return st
}

// --- helpers -----------------------------------------------------------------

type apiCaller interface {
	APICall(context.Context, string, string, string, map[string]string, string) (core.APICallResult, error)
}

func call(ctx context.Context, m apiCaller, idx, method, url string, header map[string]string, data string) (map[string]any, error) {
	res, err := m.APICall(ctx, idx, method, url, header, data)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := strings.TrimSpace(res.Body)
		var e struct {
			Error any `json:"error"`
		}
		if json.Unmarshal([]byte(msg), &e) == nil && e.Error != nil {
			switch t := e.Error.(type) {
			case string:
				msg = t
			case map[string]any:
				if s, ok := t["message"].(string); ok {
					msg = s
				}
			}
		}
		if len(msg) > 160 {
			msg = msg[:160] + "…"
		}
		return nil, fmt.Errorf("HTTP %d %s", res.StatusCode, msg)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Body), &out); err != nil {
		return nil, errors.New("usage response is not JSON")
	}
	return out, nil
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func first(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func num(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, !math.IsNaN(t) && !math.IsInf(t, 0)
	case string:
		s := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(t), "%"))
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil
	case map[string]any:
		if inner, ok := t["val"]; ok {
			return num(inner)
		}
	}
	return 0, false
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func clampPct(f float64) *float64 {
	f = math.Max(0, math.Min(100, f))
	return &f
}

func remainingFromUsed(v any) *float64 {
	if f, ok := num(v); ok {
		return clampPct(100 - f)
	}
	return nil
}

// parseTime accepts RFC3339 strings and unix seconds/milliseconds.
func parseTime(v any) *time.Time {
	switch t := v.(type) {
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05"} {
			if ts, err := time.Parse(layout, s); err == nil {
				return &ts
			}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return parseTime(f)
		}
	case float64:
		if t <= 0 {
			return nil
		}
		var ts time.Time
		if t < 1e11 {
			ts = time.Unix(int64(t), 0)
		} else {
			ts = time.UnixMilli(int64(t))
		}
		return &ts
	}
	return nil
}

func after(seconds any) *time.Time {
	if f, ok := num(seconds); ok && f > 0 {
		ts := time.Now().Add(time.Duration(f * float64(time.Second)))
		return &ts
	}
	return nil
}

func windowFromSeconds(sec float64, fallback string) (string, string) {
	switch {
	case sec == 18000:
		return "5h", "5h"
	case sec == 86400:
		return "day", "Day"
	case sec == 604800:
		return "week", "Week"
	case sec >= 28*86400 && sec <= 31*86400:
		return "month", "Month"
	case sec > 0:
		h := sec / 3600
		if h == math.Trunc(h) {
			return "custom", fmt.Sprintf("%gh", h)
		}
		return "custom", fmt.Sprintf("%gm", sec/60)
	}
	if fallback == "week" {
		return "week", "Week"
	}
	return "5h", "5h"
}

// --- Claude ------------------------------------------------------------------

var claudeHeaders = map[string]string{
	"Authorization":  "Bearer $TOKEN$",
	"Content-Type":   "application/json",
	"anthropic-beta": "oauth-2025-04-20",
}

func claude(ctx context.Context, m *core.Mgmt, idx string) (State, error) {
	body, err := call(ctx, m, idx, http.MethodGet, "https://api.anthropic.com/api/oauth/usage", claudeHeaders, "")
	if err != nil {
		return State{}, err
	}
	var st State
	windows := []struct{ key, window, scope, label string }{
		{"five_hour", "5h", "", "5h"},
		{"seven_day", "week", "", "Week"},
		{"seven_day_opus", "week", "Opus", "Week · Opus"},
		{"seven_day_sonnet", "week", "Sonnet", "Week · Sonnet"},
		{"seven_day_oauth_apps", "week", "Apps", "Week · Apps"},
	}
	for _, w := range windows {
		raw := obj(body[w.key])
		if raw == nil {
			continue
		}
		u, ok := raw["utilization"]
		if !ok {
			continue
		}
		st.Rows = append(st.Rows, Row{Window: w.window, Scope: w.scope, Label: w.label,
			Remaining: remainingFromUsed(u), ResetAt: parseTime(first(raw, "resets_at", "resetsAt"))})
	}
	// Model-scoped weekly limits (e.g. a separate allowance for one model).
	if limits, ok := body["limits"].([]any); ok {
		for _, l := range limits {
			lim := obj(l)
			if lim == nil || !strings.EqualFold(str(lim["kind"]), "weekly_scoped") {
				continue
			}
			name := str(first(obj(obj(lim["scope"])["model"]), "display_name", "displayName"))
			if name == "" {
				continue
			}
			pct, ok := num(lim["percent"])
			if !ok {
				continue
			}
			st.Rows = append(st.Rows, Row{Window: "week", Scope: name, Label: "Week · " + name,
				Remaining: clampPct(100 - pct), ResetAt: parseTime(first(lim, "resets_at", "resetsAt"))})
		}
	}
	if extra := obj(first(body, "extra_usage", "extraUsage")); extra != nil {
		if enabled, _ := extra["is_enabled"].(bool); enabled {
			limit, okL := num(first(extra, "monthly_limit", "monthlyLimit"))
			used, okU := num(first(extra, "used_credits", "usedCredits"))
			row := Row{Window: "month", Scope: "Extra", Label: "Extra usage"}
			if u, ok := num(extra["utilization"]); ok {
				row.Remaining = clampPct(100 - u)
			} else if okL && okU && limit > 0 {
				row.Remaining = clampPct((limit - used) / limit * 100)
			}
			if okL && okU {
				row.Detail = fmt.Sprintf("$%.2f / $%.2f", used/100, limit/100)
			}
			st.Rows = append(st.Rows, row)
		}
	}
	if prof, err := call(ctx, m, idx, http.MethodGet, "https://api.anthropic.com/api/oauth/profile", claudeHeaders, ""); err == nil {
		acct, org := obj(prof["account"]), obj(prof["organization"])
		switch {
		case acct["has_claude_max"] == true:
			st.Plan = "Max"
		case acct["has_claude_pro"] == true:
			st.Plan = "Pro"
		case strings.EqualFold(str(org["organization_type"]), "claude_team"):
			st.Plan = "Team"
		case acct["has_claude_max"] == false && acct["has_claude_pro"] == false:
			st.Plan = "Free"
		}
	}
	return st, nil
}

// --- ChatGPT / Codex ---------------------------------------------------------

func codexAccount(c core.Credential) (accountID, plan string) {
	records := []map[string]any{c.Raw, c.Map("metadata"), c.Map("id_token")}
	for _, r := range records {
		if r == nil {
			continue
		}
		if auth := obj(r["https://api.openai.com/auth"]); auth != nil {
			records = append(records, auth)
		}
	}
	for _, r := range records {
		if r == nil {
			continue
		}
		if accountID == "" {
			accountID = str(first(r, "chatgpt_account_id", "chatgptAccountId", "account_id"))
		}
		if plan == "" {
			plan = str(first(r, "plan_type", "planType", "chatgpt_plan_type"))
		}
	}
	return accountID, plan
}

func codex(ctx context.Context, m *core.Mgmt, c core.Credential) (State, error) {
	accountID, plan := codexAccount(c)
	header := map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type":  "application/json",
		"User-Agent":    "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
	}
	if accountID != "" {
		header["Chatgpt-Account-Id"] = accountID
	}
	body, err := call(ctx, m, c.AuthIndex(), http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", header, "")
	if err != nil {
		return State{}, err
	}
	st := State{Plan: titlePlan(firstNonEmpty(str(first(body, "plan_type", "planType")), plan))}
	add := func(rl map[string]any, scope string) {
		if rl == nil {
			return
		}
		reached := rl["limit_reached"] == true || rl["allowed"] == false
		for i, key := range []string{"primary_window", "secondary_window"} {
			win := obj(first(rl, key, map[string]string{"primary_window": "primaryWindow", "secondary_window": "secondaryWindow"}[key]))
			if win == nil {
				continue
			}
			sec, _ := num(first(win, "limit_window_seconds", "limitWindowSeconds"))
			fallback := "5h"
			if i == 1 {
				fallback = "week"
			}
			window, label := windowFromSeconds(sec, fallback)
			if scope != "" {
				label += " · " + scope
			}
			row := Row{Window: window, Scope: scope, Label: label,
				Remaining: remainingFromUsed(first(win, "used_percent", "usedPercent"))}
			row.ResetAt = parseTime(first(win, "reset_at", "resetAt"))
			if row.ResetAt == nil {
				row.ResetAt = after(first(win, "reset_after_seconds", "resetAfterSeconds"))
			}
			if row.Remaining == nil && reached {
				row.Remaining = clampPct(0)
			}
			st.Rows = append(st.Rows, row)
		}
	}
	add(obj(first(body, "rate_limit", "rateLimit")), "")
	add(obj(first(body, "code_review_rate_limit", "codeReviewRateLimit")), "Code review")
	if extra, ok := first(body, "additional_rate_limits", "additionalRateLimits").([]any); ok {
		for _, it := range extra {
			item := obj(it)
			if item == nil {
				continue
			}
			name := str(first(item, "limit_name", "limitName", "metered_feature", "meteredFeature"))
			add(obj(first(item, "rate_limit", "rateLimit")), name)
		}
	}
	sort.SliceStable(st.Rows, func(i, j int) bool {
		if (st.Rows[i].Scope == "") != (st.Rows[j].Scope == "") {
			return st.Rows[i].Scope == ""
		}
		return false
	})
	if credits := obj(body["credits"]); credits != nil {
		if bal := str(credits["balance"]); bal != "" && bal != "0" {
			st.Rows = append(st.Rows, Row{Window: "custom", Scope: "Credits", Label: "Credits", Detail: bal})
		}
	}
	return st, nil
}

// --- Google Antigravity -------------------------------------------------------

var antigravityHeaders = map[string]string{
	"Authorization": "Bearer $TOKEN$",
	"Content-Type":  "application/json",
	"User-Agent":    "antigravity/hub/2.23.0 darwin/arm64",
}

func antigravity(ctx context.Context, m *core.Mgmt, c core.Credential) (State, error) {
	project := c.Str("project_id", "projectId")
	if project == "" {
		if md := c.Map("metadata"); md != nil {
			project = str(first(md, "project_id", "projectId"))
		}
	}
	if project == "" {
		return State{}, errors.New("no Google Cloud project on this login yet; use it once and refresh")
	}
	data, _ := json.Marshal(map[string]string{"project": project})
	var (
		body    map[string]any
		lastErr error
	)
	for _, u := range []string{
		"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	} {
		b, err := call(ctx, m, c.AuthIndex(), http.MethodPost, u, antigravityHeaders, string(data))
		if err != nil {
			lastErr = err
			continue
		}
		if groups, ok := b["groups"].([]any); ok && len(groups) > 0 {
			body = b
			break
		}
		lastErr = errors.New("empty quota summary")
	}
	if body == nil {
		return State{}, lastErr
	}
	var st State
	for _, g := range body["groups"].([]any) {
		group := obj(g)
		if group == nil {
			continue
		}
		gname := str(first(group, "display_name", "displayName"))
		buckets, _ := group["buckets"].([]any)
		for _, bk := range buckets {
			b := obj(bk)
			if b == nil {
				continue
			}
			frac, ok := num(first(b, "remaining_fraction", "remainingFraction"))
			if !ok {
				continue
			}
			if frac > 1 {
				frac /= 100
			}
			bname := str(first(b, "display_name", "displayName", "description"))
			window := strings.ToLower(str(b["window"]) + " " + bname)
			w, label := "custom", bname
			switch {
			case strings.Contains(window, "5h") || strings.Contains(window, "five") || strings.Contains(window, "5-hour"):
				w, label = "5h", "5h"
			case strings.Contains(window, "week"):
				w, label = "week", "Week"
			case strings.Contains(window, "day") || strings.Contains(window, "daily"):
				w, label = "day", "Day"
			}
			if label == "" {
				label = "Quota"
			}
			if gname != "" {
				label += " · " + gname
			}
			st.Rows = append(st.Rows, Row{Window: w, Scope: gname, Label: label,
				Remaining: clampPct(frac * 100), ResetAt: parseTime(first(b, "reset_time", "resetTime"))})
		}
	}
	if tier, err := call(ctx, m, c.AuthIndex(), http.MethodPost,
		"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", antigravityHeaders,
		`{"metadata":{"ideType":"ANTIGRAVITY"}}`); err == nil {
		eff := obj(first(tier, "paidTier", "paid_tier"))
		if str(eff["id"]) == "" {
			eff = obj(first(tier, "currentTier", "current_tier"))
		}
		switch strings.ToLower(str(eff["id"])) {
		case "free-tier":
			st.Plan = "Free"
		case "g1-pro-tier":
			st.Plan = "AI Pro"
		case "g1-ultra-tier":
			st.Plan = "AI Ultra"
		case "g1-ultra-lite-tier":
			st.Plan = "Ultra Lite"
		default:
			st.Plan = str(eff["name"])
		}
	}
	return st, nil
}

// --- Kimi -------------------------------------------------------------------

func kimi(ctx context.Context, m apiCaller, c core.Credential) (State, error) {
	endpoint := "https://api.kimi.com/coding/v1/usages"
	if c.Provider() == "kimi-ai" {
		endpoint = "https://api.kimi.ai/coding/v1/usages"
	}
	body, err := call(ctx, m, c.AuthIndex(), http.MethodGet, endpoint,
		map[string]string{"Authorization": "Bearer $TOKEN$"}, "")
	if err != nil {
		return State{}, err
	}
	var st State
	items, _ := body["limits"].([]any)
	if u := obj(body["usage"]); u != nil {
		items = append(items, u)
	}
	for _, it := range items {
		raw := obj(it)
		if raw == nil {
			continue
		}
		detail := obj(raw["detail"])
		if detail == nil {
			detail = raw
		}
		limit, okL := num(detail["limit"])
		used, okU := num(detail["used"])
		if !okU {
			if rem, okR := num(detail["remaining"]); okR && okL {
				used, okU = limit-rem, true
			}
		}
		if !okL && !okU {
			continue
		}
		win := obj(raw["window"])
		dur, _ := num(first(win, "duration"))
		unit := strings.ToLower(strings.TrimPrefix(strings.ToLower(str(first(win, "timeUnit", "time_unit"))), "time_unit_"))
		window, label := "custom", str(first(raw, "label", "name", "title", "scope"))
		switch {
		case strings.HasPrefix(unit, "week") || (strings.HasPrefix(unit, "day") && dur == 7):
			window, label = "week", "Week"
		case strings.HasPrefix(unit, "hour") && dur == 5, strings.HasPrefix(unit, "minute") && dur == 300:
			window, label = "5h", "5h"
		case strings.HasPrefix(unit, "day") && dur == 1:
			window, label = "day", "Day"
		}
		if label == "" {
			label = "Quota"
		}
		row := Row{Window: window, Label: label}
		if okL && limit > 0 {
			row.Remaining = clampPct(math.Max(0, limit-used) / limit * 100)
			row.Detail = fmt.Sprintf("%g / %g", used, limit)
		}
		row.ResetAt = parseTime(first(detail, "reset_at", "resetAt", "reset_time", "resetTime"))
		if row.ResetAt == nil {
			row.ResetAt = after(first(detail, "reset_in", "resetIn", "ttl"))
		}
		st.Rows = append(st.Rows, row)
	}
	return st, nil
}

// --- xAI / Grok ---------------------------------------------------------------

func xai(ctx context.Context, m *core.Mgmt, c core.Credential) (State, error) {
	header := map[string]string{
		"Authorization":         "Bearer $TOKEN$",
		"x-xai-token-auth":      "xai-grok-cli",
		"x-grok-client-version": "0.2.91",
		"accept":                "*/*",
		"user-agent":            "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
	}
	if uid := c.Str("sub", "user_id", "userId"); uid != "" {
		header["x-userid"] = uid
	} else if md := c.Map("metadata"); md != nil {
		if uid := str(first(md, "sub", "user_id", "userId")); uid != "" {
			header["x-userid"] = uid
		}
	}
	var st State
	weekly, errW := call(ctx, m, c.AuthIndex(), http.MethodGet, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", header, "")
	if errW == nil {
		cfg := obj(weekly["config"])
		if cfg == nil {
			cfg = weekly
		}
		period := obj(first(cfg, "currentPeriod", "current_period"))
		if pct, ok := num(first(cfg, "creditUsagePercent", "credit_usage_percent")); ok {
			window, label := "custom", "Period"
			if strings.Contains(strings.ToLower(str(period["type"])), "week") {
				window, label = "week", "Week"
			}
			st.Rows = append(st.Rows, Row{Window: window, Label: label, Remaining: clampPct(100 - pct),
				ResetAt: parseTime(period["end"])})
		}
	}
	monthly, errM := call(ctx, m, c.AuthIndex(), http.MethodGet, "https://cli-chat-proxy.grok.com/v1/billing", header, "")
	if errM == nil {
		cfg := obj(monthly["config"])
		if cfg == nil {
			cfg = monthly
		}
		limit, okL := num(first(cfg, "monthlyLimit", "monthly_limit"))
		used, okU := num(cfg["used"])
		if okL && okU && limit > 0 {
			st.Rows = append(st.Rows, Row{Window: "month", Label: "Month", Remaining: clampPct((limit - used) / limit * 100),
				Detail:  fmt.Sprintf("$%.2f / $%.2f", used/100, limit/100),
				ResetAt: parseTime(first(cfg, "billingPeriodEnd", "billing_period_end"))})
			switch limit {
			case 150000:
				st.Plan = "SuperGrok Heavy"
			case 15000:
				st.Plan = "SuperGrok"
			}
		}
	}
	if len(st.Rows) == 0 {
		if errW != nil {
			return st, errW
		}
		if errM != nil {
			return st, errM
		}
	}
	return st, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func titlePlan(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	return strings.ToUpper(p[:1]) + p[1:]
}
