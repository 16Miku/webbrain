package quota

import (
	"context"
	"net/http"
	"testing"

	"github.com/esokullu/webbrain-systray/internal/core"
)

type recordingCaller struct {
	index, method, url string
	header             map[string]string
}

func (m *recordingCaller) APICall(_ context.Context, index, method, url string, header map[string]string, _ string) (core.APICallResult, error) {
	m.index, m.method, m.url, m.header = index, method, url, header
	return core.APICallResult{
		StatusCode: http.StatusOK,
		Body:       `{"limits":[{"window":{"duration":5,"timeUnit":"hour"},"detail":{"limit":100,"used":25}}]}`,
	}, nil
}

func TestKimiUsageEndpoint(t *testing.T) {
	for _, tc := range []struct {
		provider, endpoint string
	}{
		{"kimi", "https://api.kimi.com/coding/v1/usages"},
		{"kimi-ai", "https://api.kimi.ai/coding/v1/usages"},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			m := &recordingCaller{}
			c := core.Credential{Raw: map[string]any{"provider": tc.provider, "auth_index": "account-index"}}
			st, err := kimi(context.Background(), m, c)
			if err != nil {
				t.Fatal(err)
			}
			if m.url != tc.endpoint || m.index != "account-index" || m.method != http.MethodGet {
				t.Fatalf("request: index=%q method=%q url=%q", m.index, m.method, m.url)
			}
			if m.header["Authorization"] != "Bearer $TOKEN$" {
				t.Fatalf("credential substitution header: %q", m.header["Authorization"])
			}
			if len(st.Rows) != 1 || st.Rows[0].Window != "5h" || st.Rows[0].Remaining == nil || *st.Rows[0].Remaining != 75 {
				t.Fatalf("unexpected quota rows: %+v", st.Rows)
			}
		})
	}
}
