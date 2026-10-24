package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Mgmt is a small client for the embedded proxy's v8 management API.
type Mgmt struct {
	base   string
	pass   string
	apiKey string
	http   *http.Client
}

func newMgmt(base, pass, apiKey string) *Mgmt {
	return &Mgmt{base: base, pass: pass, apiKey: apiKey, http: &http.Client{Timeout: 60 * time.Second}}
}

type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	msg := strings.TrimSpace(e.Body)
	var parsed struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(msg), &parsed) == nil {
		if parsed.Error != "" {
			msg = parsed.Error
		} else if parsed.Message != "" {
			msg = parsed.Message
		}
	}
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	return fmt.Sprintf("management API %d: %s", e.Status, msg)
}

func (m *Mgmt) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, m.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.pass)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Status: resp.StatusCode, Body: string(data)}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Credential is one entry of GET /v8/management/credentials. Raw keeps every
// field for provider-specific lookups (id_token claims, project ids, ...).
type Credential struct {
	Raw map[string]any
}

func (c Credential) Str(keys ...string) string {
	for _, k := range keys {
		if v, ok := c.Raw[k]; ok {
			switch t := v.(type) {
			case string:
				if s := strings.TrimSpace(t); s != "" {
					return s
				}
			case float64:
				return fmt.Sprintf("%v", t)
			}
		}
	}
	return ""
}

func (c Credential) Bool(key string) bool {
	v, _ := c.Raw[key].(bool)
	return v
}

func (c Credential) Map(key string) map[string]any {
	v, _ := c.Raw[key].(map[string]any)
	return v
}

func (c Credential) Name() string      { return c.Str("name", "id") }
func (c Credential) AuthIndex() string { return c.Str("auth_index", "authIndex") }
func (c Credential) Provider() string {
	return strings.ToLower(c.Str("provider", "type", "account_type"))
}

func (m *Mgmt) Credentials(ctx context.Context) ([]Credential, error) {
	var out struct {
		Files []map[string]any `json:"files"`
	}
	if err := m.do(ctx, http.MethodGet, "/v8/management/credentials", nil, &out); err != nil {
		return nil, err
	}
	creds := make([]Credential, 0, len(out.Files))
	for _, f := range out.Files {
		creds = append(creds, Credential{Raw: f})
	}
	return creds, nil
}

// LoginStart is the reply to starting an OAuth or device login.
type LoginStart struct {
	Status    string `json:"status"`
	URL       string `json:"url"`
	State     string `json:"state"`
	Flow      string `json:"flow,omitempty"`
	UserCode  string `json:"user_code,omitempty"`
	ExpiresIn int    `json:"expires_in,omitempty"`
}

func (m *Mgmt) StartLogin(ctx context.Context, provider string) (LoginStart, error) {
	var out LoginStart
	q := url.Values{"provider": {provider}, "is_webui": {"true"}}
	err := m.do(ctx, http.MethodGet, "/v8/management/oauth/auth-url?"+q.Encode(), nil, &out)
	return out, err
}

// LoginStatus returns "wait", "ok" or "error" (with a message).
func (m *Mgmt) LoginStatus(ctx context.Context, state string) (string, string, error) {
	var out struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	err := m.do(ctx, http.MethodGet, "/v8/management/oauth/status?state="+url.QueryEscape(state), nil, &out)
	return out.Status, out.Error, err
}

func (m *Mgmt) CancelLogin(ctx context.Context, state string) error {
	return m.do(ctx, http.MethodDelete, "/v8/management/oauth/session?state="+url.QueryEscape(state), nil, nil)
}

// SubmitCallback hands a pasted redirect URL to a pending login, for when the
// browser could not reach the local callback port.
func (m *Mgmt) SubmitCallback(ctx context.Context, provider, redirectURL string) error {
	body := map[string]string{"redirect_url": redirectURL}
	if provider != "" {
		body["provider"] = provider
	}
	return m.do(ctx, http.MethodPost, "/v8/management/oauth/callback", body, nil)
}

func (m *Mgmt) DeleteCredential(ctx context.Context, name string) error {
	return m.do(ctx, http.MethodDelete, "/v8/management/credentials?name="+url.QueryEscape(name), nil, nil)
}

func (m *Mgmt) SetCredentialDisabled(ctx context.Context, name string, disabled bool) error {
	return m.do(ctx, http.MethodPatch, "/v8/management/credentials/status", map[string]any{"name": name, "disabled": disabled}, nil)
}

// APICallResult is the upstream response relayed by /requests/api-call.
type APICallResult struct {
	StatusCode int                 `json:"status_code"`
	Header     map[string][]string `json:"header"`
	Body       string              `json:"body"`
}

// APICall performs an upstream request with a stored credential; "$TOKEN$" in
// headers or body is replaced with the credential's (refreshed) access token.
func (m *Mgmt) APICall(ctx context.Context, authIndex, method, rawURL string, header map[string]string, data string) (APICallResult, error) {
	var out APICallResult
	body := map[string]any{"auth_index": authIndex, "method": method, "url": rawURL, "header": header}
	if data != "" {
		body["data"] = data
	}
	err := m.do(ctx, http.MethodPost, "/v8/management/requests/api-call", body, &out)
	return out, err
}

// Models lists the model ids the proxy currently serves to clients.
func (m *Mgmt) Models(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.base+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+m.apiKey)
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
		return nil, &APIError{Status: resp.StatusCode, Body: string(data)}
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Data))
	for _, d := range out.Data {
		ids = append(ids, d.ID)
	}
	return ids, nil
}
