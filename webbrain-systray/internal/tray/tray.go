// Package tray shows the companion's status-bar / notification-area icon and
// menu. Windows and Linux use fyne.io/systray; macOS uses a small Cocoa
// binding built on purego so the whole app cross-compiles without cgo.
package tray

// Item is one menu entry. A zero Item with Separator set draws a line.
type Item struct {
	Title     string
	Tooltip   string
	Disabled  bool
	Checked   bool
	Separator bool
	// Secondary renders the row in a dimmer style where supported (macOS).
	Secondary bool
	OnClick   func()
	Children  []Item
}

// Icon carries the artwork for every platform.
type Icon struct {
	Template []byte // macOS: monochrome PNG used as a template image (@2x, 144 dpi)
	PNG      []byte // Linux: colour PNG
	ICO      []byte // Windows: .ico
}

// Options configure Run.
type Options struct {
	Icon    Icon
	Tooltip string
	// Menu builds the current menu. It is called when the menu is about to
	// open (macOS) and whenever Refresh is called.
	Menu    func() []Item
	OnReady func()
	OnExit  func()
}
