// Package accounts knows which subscriptions can be added and turns the
// proxy's credential list into the companion's account model.
package accounts

import (
	"sort"
	"strings"

	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/quota"
)

// Provider is a subscription the user can sign in with.
type Provider struct {
	ID       string   `json:"id"`       // login id for the management API
	Matches  []string `json:"-"`        // credential provider names it produces
	Name     string   `json:"name"`     // short brand name
	Product  string   `json:"product"`  // what the subscription is called
	Flow     string   `json:"flow"`     // "browser" or "device"
	Quota    bool     `json:"quota"`    // usage windows are readable
	Primary  bool     `json:"primary"`  // shown before "more"
	Initials string   `json:"initials"` // badge text
	Hue      int      `json:"hue"`      // badge hue (HSL)
}

// Catalog lists the subscriptions supported by the embedded CLIProxyAPI v8.
var Catalog = []Provider{
	{ID: "claude", Matches: []string{"claude", "anthropic"}, Name: "Claude", Product: "Pro, Max or Team plan", Flow: "browser", Quota: true, Primary: true, Initials: "Cl", Hue: 22},
	{ID: "codex", Matches: []string{"codex"}, Name: "ChatGPT", Product: "Plus or Pro, through Codex sign-in", Flow: "browser", Quota: true, Primary: true, Initials: "GP", Hue: 160},
	{ID: "antigravity", Matches: []string{"antigravity"}, Name: "Google", Product: "Gemini through Antigravity", Flow: "browser", Quota: true, Primary: true, Initials: "G", Hue: 215},
	{ID: "xai", Matches: []string{"xai", "grok"}, Name: "Grok", Product: "SuperGrok, through Grok Build", Flow: "device", Quota: true, Primary: true, Initials: "X", Hue: 0},
	{ID: "kimi-ai", Matches: []string{"kimi-ai"}, Name: "Kimi", Product: "Kimi Code on kimi.ai", Flow: "device", Quota: true, Primary: true, Initials: "K", Hue: 265},
	{ID: "kimi", Matches: []string{"kimi"}, Name: "Kimi (CN)", Product: "Kimi Code on kimi.com", Flow: "device", Quota: true, Initials: "K", Hue: 265},
	{ID: "meta", Matches: []string{"meta"}, Name: "Meta Muse", Product: "Muse Code", Flow: "device", Initials: "M", Hue: 205},
	{ID: "devin", Matches: []string{"devin", "cognition"}, Name: "Devin", Product: "Devin account", Flow: "browser", Initials: "D", Hue: 145},
}

// ProviderFor maps a credential's provider name to the catalog entry.
func ProviderFor(name string) Provider {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, p := range Catalog {
		for _, m := range p.Matches {
			if m == name {
				return p
			}
		}
	}
	return Provider{ID: name, Name: strings.ToUpper(name[:min(1, len(name))]) + name[min(1, len(name)):], Initials: strings.ToUpper(name[:min(2, len(name))]), Hue: 250}
}

func Lookup(id string) (Provider, bool) {
	for _, p := range Catalog {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Account is one signed-in subscription.
type Account struct {
	Name          string      `json:"name"` // credential file name (stable id)
	Provider      string      `json:"provider"`
	ProviderName  string      `json:"provider_name"`
	Initials      string      `json:"initials"`
	Hue           int         `json:"hue"`
	Email         string      `json:"email,omitempty"`
	Label         string      `json:"label,omitempty"`
	Disabled      bool        `json:"disabled"`
	Unavailable   bool        `json:"unavailable"`
	Status        string      `json:"status,omitempty"`
	StatusMessage string      `json:"status_message,omitempty"`
	Quota         quota.State `json:"quota"`
	QuotaKnown    bool        `json:"quota_supported"`
}

// Who tells logins of the same provider apart: the email (or label), else the
// credential's file name.
func (a Account) Who() string {
	if a.Email != "" {
		return a.Email
	}
	return strings.TrimSuffix(a.Name, ".json")
}

// FromCredentials builds accounts, attaching cached quotas by credential name.
func FromCredentials(creds []core.Credential, quotas map[string]quota.State) []Account {
	out := make([]Account, 0, len(creds))
	for _, c := range creds {
		prov := c.Provider()
		if prov == "" {
			continue
		}
		p := ProviderFor(prov)
		a := Account{
			Name:          c.Name(),
			Provider:      prov,
			ProviderName:  p.Name,
			Initials:      p.Initials,
			Hue:           p.Hue,
			Email:         c.Str("email", "account"),
			Label:         c.Str("label"),
			Disabled:      c.Bool("disabled"),
			Unavailable:   c.Bool("unavailable"),
			Status:        c.Str("status"),
			StatusMessage: c.Str("status_message"),
			QuotaKnown:    quota.Supported(prov),
		}
		if a.Email == "" {
			a.Email = a.Label
		}
		if q, ok := quotas[a.Name]; ok {
			a.Quota = q
		} else if a.QuotaKnown {
			a.Quota = quota.State{Status: "loading"}
		} else {
			a.Quota = quota.State{Status: "unsupported"}
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := providerRank(out[i].Provider), providerRank(out[j].Provider)
		if pi != pj {
			return pi < pj
		}
		return out[i].Email < out[j].Email
	})
	return out
}

func providerRank(p string) int {
	for i, c := range Catalog {
		for _, m := range c.Matches {
			if m == p {
				return i
			}
		}
	}
	return len(Catalog)
}
