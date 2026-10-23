//go:build !darwin

package tray

import (
	"runtime"
	"sync"
	"time"

	"fyne.io/systray"
)

var (
	opts      Options
	refreshCh = make(chan struct{}, 1)
	buildMu   sync.Mutex
	stopClick chan struct{}
	lastSig   string
	onTap     func()
)

// SetOnTap sets the action for a primary click on the icon (open the panel);
// the menu stays on the secondary click.
func SetOnTap(fn func()) { onTap = fn }

// Run blocks running the platform event loop. Call it from main.
func Run(o Options) {
	opts = o
	systray.Run(onReady, func() {
		if opts.OnExit != nil {
			opts.OnExit()
		}
	})
}

func onReady() {
	if runtime.GOOS == "windows" {
		systray.SetIcon(opts.Icon.ICO)
	} else {
		systray.SetIcon(opts.Icon.PNG)
		systray.SetTitle("WebBrain")
	}
	systray.SetTooltip(opts.Tooltip)
	if onTap != nil {
		systray.SetOnTapped(func() { go onTap() })
	}
	build(true)
	go loop()
	if opts.OnReady != nil {
		go opts.OnReady()
	}
}

// Hidden reports whether the icon is known to be invisible (macOS only).
func Hidden() bool { return false }

// Refresh rebuilds the menu from Options.Menu.
func Refresh() {
	select {
	case refreshCh <- struct{}{}:
	default:
	}
}

// SetTooltip updates the hover text.
func SetTooltip(s string) { systray.SetTooltip(s) }

// Quit ends Run.
func Quit() { systray.Quit() }

func loop() {
	tick := time.NewTicker(60 * time.Second) // keep "resets in …" texts fresh
	defer tick.Stop()
	for {
		select {
		case <-refreshCh:
			time.Sleep(150 * time.Millisecond) // coalesce bursts
			select {
			case <-refreshCh:
			default:
			}
			build(false)
		case <-tick.C:
			build(false)
		case <-systray.TrayOpenedCh:
			build(false)
		}
	}
}

// signature detects whether anything visible changed, to avoid rebuilding a
// menu the user may have open.
func signature(items []Item) string {
	var b []byte
	var walk func([]Item)
	walk = func(list []Item) {
		for _, it := range list {
			b = append(b, it.Title...)
			b = append(b, '|')
			if it.Disabled {
				b = append(b, 'd')
			}
			if it.Checked {
				b = append(b, 'c')
			}
			if it.Separator {
				b = append(b, '-')
			}
			if len(it.Children) > 0 {
				b = append(b, '[')
				walk(it.Children)
				b = append(b, ']')
			}
			b = append(b, '\n')
		}
	}
	walk(items)
	return string(b)
}

func build(force bool) {
	if opts.Menu == nil {
		return
	}
	items := opts.Menu()
	buildMu.Lock()
	defer buildMu.Unlock()
	sig := signature(items)
	if !force && sig == lastSig {
		return
	}
	lastSig = sig
	if stopClick != nil {
		close(stopClick)
	}
	stopClick = make(chan struct{})
	systray.ResetMenu()
	add(nil, items, stopClick)
}

func add(parent *systray.MenuItem, items []Item, stop chan struct{}) {
	for _, it := range items {
		if it.Separator {
			if parent == nil {
				systray.AddSeparator()
			} else {
				parent.AddSeparator()
			}
			continue
		}
		var mi *systray.MenuItem
		checkable := it.Checked
		switch {
		case parent == nil && checkable:
			mi = systray.AddMenuItemCheckbox(it.Title, it.Tooltip, true)
		case parent == nil:
			mi = systray.AddMenuItem(it.Title, it.Tooltip)
		case checkable:
			mi = parent.AddSubMenuItemCheckbox(it.Title, it.Tooltip, true)
		default:
			mi = parent.AddSubMenuItem(it.Title, it.Tooltip)
		}
		if it.Disabled {
			mi.Disable()
		}
		if len(it.Children) > 0 {
			add(mi, it.Children, stop)
		}
		if it.OnClick != nil {
			go func(ch chan struct{}, fn func()) {
				for {
					select {
					case <-ch:
						go fn()
					case <-stop:
						return
					}
				}
			}(mi.ClickedCh, it.OnClick)
		}
	}
}
