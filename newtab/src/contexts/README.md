# Translation System

## Refactored Translation System ✨

The app now has a robust, centralized translation system that updates instantly without page refresh!

### Using Translations (New API)

**Recommended approach** - Use the `useT()` hook:

```jsx
import { useT } from 'contexts/TranslationContext';

function MyComponent() {
  const t = useT();

  return (
    <div>
      <h1>{t('modals.main.title')}</h1>
      <p>{t('modals.main.description')}</p>
    </div>
  );
}
```

**Alternative** - Use the full hook:

```jsx
import { useTranslation } from 'contexts/TranslationContext';

function MyComponent() {
  const { t, language, changeLanguage } = useTranslation();

  return (
    <div>
      <h1>{t('modals.main.title')}</h1>
      <button onClick={() => changeLanguage('es')}>Español</button>
    </div>
  );
}
```

### Backward Compatibility

The old `variables.getMessage()` method still works and is automatically reactive:

```jsx
// This still works and updates on language change
const title = variables.getMessage('modals.main.title');
```

This allows gradual migration of components.

### How It Works

1. **TranslationProvider** wraps the app and manages the i18n instance
2. **Single source of truth** - All translation logic is centralized in the context
3. **Automatic reactivity** - Components using `t()` automatically re-render on language change
4. **Backward compatible** - `variables.getMessage()` is updated to use the context internally
5. **No EventBus needed** - Direct context updates for language changes

### Benefits

✅ **Instant updates** - No page refresh needed
✅ **Single API** - One consistent way to translate
✅ **Automatic re-renders** - React handles updates efficiently
✅ **Minimal performance impact** - Translations pre-loaded, only switching active language
✅ **Type-safe ready** - Easy to add TypeScript support later
✅ **Clean architecture** - Centralized translation logic

### Migration Guide

**Before:**
```jsx
const title = variables.getMessage('modals.main.title');
```

**After:**
```jsx
const t = useT();
const title = t('modals.main.title');
```

### Components Updated

Core navigation and UI:
- ✅ TranslationContext (centralized API)
- ✅ Radio component (language selector)
- ✅ Tab, Tabs (sidebar navigation)
- ✅ ModalTopBar (breadcrumbs)
- ✅ Settings view
- ✅ Language section
- ✅ Refresh button
- ✅ Welcome modal

All other components continue to work via backward compatibility.
