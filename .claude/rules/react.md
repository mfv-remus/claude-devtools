---
globs: ["src/renderer/**/*.tsx"]
---

# React Conventions

## Component Structure
- Components in `src/renderer/components/` organized by feature
- One component per file, PascalCase naming
- Colocate related hooks and utilities

## State Management (Zustand)
```typescript
// Slices pattern
projects: Project[]
selectedProjectId: string | null
projectsLoading: boolean
projectsError: string | null
```

Each domain slice includes:
- Data array or object
- Selected/active item ID
- Loading state
- Error state

## Hooks
- Custom hooks in `src/renderer/hooks/`
- Prefix with `use`: `useAutoScrollBottom`, `useTheme`
- Keep hooks focused and composable

## Component Organization
```
components/
├── chat/           # Chat display, items, viewers, SessionContextPanel
├── common/         # Shared components (badges, token display)
├── dashboard/      # Dashboard views
├── layout/         # Layout components (headers, shells)
├── imports/        # Imports dialog, sidebar section, eval-run views (HTTP mode)
├── notifications/  # Notification panels and badges
├── search/         # Search UI and results
├── settings/       # Settings pages and controls
│   ├── components/ # Reusable setting controls
│   ├── hooks/      # Settings-specific hooks
│   ├── sections/   # Setting sections
│   └── NotificationTriggerSettings/  # Trigger config UI
└── sidebar/        # Sidebar navigation
```

## Contexts
- `contexts/TabUIContext.tsx` - Per-tab UI state isolation
